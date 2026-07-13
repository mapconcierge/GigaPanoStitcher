// =========================================================
// GigaPanoStitcher — stitching engine (Web Worker, Phase 4)
// =========================================================
// Classic worker: loads OpenCV.js (WASM) via importScripts on
// first use. The official OpenCV.js build does not expose the
// high-level Stitcher class, so we run a matrix-guided
// pipeline instead — the grid tells us which images overlap:
//
//   1. For every adjacent pair, run ORB on the two overlap
//      strips only (not the full frames) and match with a
//      Hamming BFMatcher + Lowe ratio test.
//   2. Estimate the pair offset as the median match delta
//      (with MAD outlier rejection) — GigaPan heads rotate
//      about a fixed axis, so a translation model per pair
//      holds well at moderate focal lengths.
//   3. Integrate offsets across the grid (left/top constraints
//      averaged) into absolute positions.
//   4. Composite onto an OffscreenCanvas with linear feather
//      blending on interior edges.
//
// GitHub Pages cannot send COOP/COEP headers, so there is no
// SharedArrayBuffer → single-threaded WASM build.
//
// Protocol:
//   in : {type:'stitch', cells:[{id,row,col,bitmap}], rows, cols,
//         mode:'rectangle'|'equirectangular', jpegQuality}
//   out: {type:'progress', pct, note}
//        {type:'done', blob, width, height, mode, pairStats}
//        {type:'error', message}

'use strict';

// Vendored copy of the official OpenCV.js 4.10.0 build (via the
// @techstark/opencv-js 4.10.0-release.1 npm package). Served
// same-origin because importScripts has no SRI: this worker holds
// every source photo, so it must never execute unverified
// cross-origin code (sha384: XsTfGA62I8LzqS3D7IcgiSOCrJuECWLcg4s1
// M0AnrkDCcJ8lXX+j+qdg+o6t7KZa).
const OPENCV_URL = '../vendor/opencv-4.10.0.js';

/** Fraction of each frame searched for features along a shared edge. */
const STRIP_FRAC = 0.5;
/** ORB feature budget per strip. */
const ORB_FEATURES = 1200;
/** Lowe ratio-test threshold. */
const RATIO = 0.75;
/** Minimum surviving matches for a pair offset to be trusted. */
const MIN_MATCHES = 8;
/** Assumed overlap fraction when matching fails (GigaPan default ~30%). */
const FALLBACK_OVERLAP = 0.3;
/** RANSAC iterations / inlier radius (px) for pair-offset estimation. */
const RANSAC_ITERS = 300;
const RANSAC_TOL = 3;
/** Iterations of the global position relaxation solve. */
const RELAX_ITERS = 120;

let cvReadyPromise = null;

function loadOpenCV() {
  if (!cvReadyPromise) {
    cvReadyPromise = new Promise((resolve, reject) => {
      try {
        importScripts(OPENCV_URL);
      } catch (e) {
        cvReadyPromise = null;
        reject(new Error(`Failed to download OpenCV.js: ${e.message}`));
        return;
      }
      // Depending on the build, `cv` is a Promise or a Module object.
      if (typeof cv === 'undefined') {
        reject(new Error('OpenCV.js loaded but `cv` is undefined'));
      } else if (typeof cv.then === 'function') {
        cv.then((mod) => { self.cv = mod; resolve(); }, reject);
      } else if (cv.Mat) {
        resolve();
      } else {
        cv.onRuntimeInitialized = resolve;
      }
    });
  }
  return cvReadyPromise;
}

const progress = (pct, note) => postMessage({ type: 'progress', pct, note });

// ---- cylindrical pre-warp ------------------------------------
// A rotating head sweeps a cylinder, but each frame is a PLANAR
// projection: content near the frame edges is stretched relative to
// the centre, so adjacent frames can never fully agree under a pure
// translation — that residual shows up as misaligned railings/cars
// at the seams. Reprojecting every frame onto the common cylinder
// (radius = focal length in pixels) removes that systematic error;
// what remains for the matcher really is translation.

/** Build remap tables for one frame geometry (cached by caller). */
function cylMaps(w, h, fpx) {
  const outW = Math.max(2, Math.round(2 * fpx * Math.atan(w / (2 * fpx))));
  const outH = h;
  const mapX = new cv.Mat(outH, outW, cv.CV_32FC1);
  const mapY = new cv.Mat(outH, outW, cv.CV_32FC1);
  const cx = w / 2, cy = h / 2, ocx = outW / 2, ocy = outH / 2;
  const dx = mapX.data32F, dy = mapY.data32F;
  for (let yo = 0; yo < outH; yo++) {
    for (let xo = 0; xo < outW; xo++) {
      const theta = (xo - ocx) / fpx;          // pan angle of this column
      const i = yo * outW + xo;
      dx[i] = cx + fpx * Math.tan(theta);
      dy[i] = cy + (yo - ocy) / Math.cos(theta);
    }
  }
  return { mapX, mapY, outW, outH };
}

/** Warp one ImageBitmap onto the cylinder; returns an OffscreenCanvas. */
function cylWarp(bitmap, maps) {
  const src = matFromBitmap(bitmap, 0, 0, bitmap.width, bitmap.height);
  const dst = new cv.Mat();
  cv.remap(src, dst, maps.mapX, maps.mapY, cv.INTER_LINEAR,
    cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  const out = new OffscreenCanvas(maps.outW, maps.outH);
  out.getContext('2d').putImageData(
    new ImageData(new Uint8ClampedArray(dst.data), maps.outW, maps.outH), 0, 0);
  src.delete(); dst.delete();
  return out;
}

// ---- pixel access --------------------------------------------

/** Crop a rect of an ImageBitmap into an RGBA cv.Mat. */
function matFromBitmap(bmp, x, y, w, h) {
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, x, y, w, h, 0, 0, w, h);
  return cv.matFromImageData(ctx.getImageData(0, 0, w, h));
}

// ---- feature matching ----------------------------------------

/** ORB keypoints + descriptors of an RGBA Mat (consumes nothing). */
function detect(rgba) {
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const orb = new cv.ORB(ORB_FEATURES);
  const kp = new cv.KeyPointVector();
  const des = new cv.Mat();
  const noMask = new cv.Mat();
  orb.detectAndCompute(gray, noMask, kp, des);
  gray.delete(); orb.delete(); noMask.delete();
  return { kp, des };
}

/**
 * RANSAC over 2D translations: pick the delta supported by the most
 * matches, then refine as the inlier mean. Robust against the
 * multi-modal delta distributions that repeated structures and
 * parallax produce (where a plain median lands between modes and
 * ghosts the whole seam).
 */
function ransacTranslation(dxs, dys) {
  const n = dxs.length;
  let bestIdx = -1, bestCount = 0;
  // Exhaustive when the candidate set fits the budget; otherwise
  // sample randomly across the WHOLE set (indexing 0..trials would
  // only ever test the first, query-ordered matches).
  const exhaustive = n <= RANSAC_ITERS;
  for (let it = 0; it < Math.min(RANSAC_ITERS, n); it++) {
    const i = exhaustive ? it : Math.floor(Math.random() * n);
    let count = 0;
    for (let j = 0; j < n; j++) {
      if (Math.abs(dxs[j] - dxs[i]) <= RANSAC_TOL &&
          Math.abs(dys[j] - dys[i]) <= RANSAC_TOL) count++;
    }
    if (count > bestCount) { bestCount = count; bestIdx = i; }
  }
  if (bestIdx < 0 || bestCount < MIN_MATCHES) return null;
  let sx = 0, sy = 0;
  for (let j = 0; j < n; j++) {
    if (Math.abs(dxs[j] - dxs[bestIdx]) <= RANSAC_TOL &&
        Math.abs(dys[j] - dys[bestIdx]) <= RANSAC_TOL) { sx += dxs[j]; sy += dys[j]; }
  }
  return { dx: sx / bestCount, dy: sy / bestCount, inliers: bestCount };
}

/**
 * Robust translation between two strips. Candidate deltas are
 * pre-filtered to the geometrically possible window (`expect`),
 * then RANSAC picks the dominant mode. Returns null when unreliable.
 * Deltas are expressed in GLOBAL frame coordinates of each image
 * (strip origins are added back via ax/ay/bx/by).
 */
function stripOffset(stripA, stripB, ax, ay, bx, by, expect) {
  const A = detect(stripA);
  const B = detect(stripB);
  let result = null;

  if (A.des.rows >= MIN_MATCHES && B.des.rows >= MIN_MATCHES) {
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
    const knn = new cv.DMatchVectorVector();
    bf.knnMatch(A.des, B.des, knn, 2);

    const dxs = [], dys = [];
    for (let i = 0; i < knn.size(); i++) {
      const pair = knn.get(i);
      if (pair.size() < 2) continue;
      const m = pair.get(0), n = pair.get(1);
      if (m.distance < RATIO * n.distance) {
        const pa = A.kp.get(m.queryIdx).pt;
        const pb = B.kp.get(m.trainIdx).pt;
        const dx = (ax + pa.x) - (bx + pb.x);
        const dy = (ay + pa.y) - (by + pb.y);
        if (dx >= expect.minDx && dx <= expect.maxDx &&
            dy >= expect.minDy && dy <= expect.maxDy) {
          dxs.push(dx);
          dys.push(dy);
        }
      }
    }
    bf.delete(); knn.delete();

    if (dxs.length >= MIN_MATCHES) result = ransacTranslation(dxs, dys);
  }
  A.kp.delete(); A.des.delete(); B.kp.delete(); B.des.delete();
  return result;
}

/**
 * Offset of image B relative to image A along a shared edge.
 * axis: 'h' (B right of A) or 'v' (B below A).
 * Returns {dx, dy, inliers|0, fallback:boolean}.
 */
function pairOffset(a, b, axis) {
  const w = a.bitmap.width, h = a.bitmap.height;
  // Geometrically possible window for the neighbor's displacement:
  // it must lie ahead along the pan/tilt axis (5–98% of the frame)
  // and only drift moderately on the perpendicular axis.
  const expect = axis === 'h'
    ? { minDx: 0.05 * w, maxDx: 0.98 * w, minDy: -0.45 * h, maxDy: 0.45 * h }
    : { minDx: -0.45 * w, maxDx: 0.45 * w, minDy: 0.05 * h, maxDy: 0.98 * h };

  const stripWA = Math.round((axis === 'h' ? w : h) * STRIP_FRAC);
  const stripWB = Math.round((axis === 'h' ? b.bitmap.width : b.bitmap.height) * STRIP_FRAC);
  let sa, sb, off = null;
  if (axis === 'h') {
    const ax = w - stripWA;
    sa = matFromBitmap(a.bitmap, ax, 0, stripWA, h);
    sb = matFromBitmap(b.bitmap, 0, 0, stripWB, b.bitmap.height);
    off = stripOffset(sa, sb, ax, 0, 0, 0, expect);
  } else {
    const ay = h - stripWA;
    sa = matFromBitmap(a.bitmap, 0, ay, w, stripWA);
    sb = matFromBitmap(b.bitmap, 0, 0, b.bitmap.width, stripWB);
    off = stripOffset(sa, sb, 0, ay, 0, 0, expect);
  }
  sa.delete(); sb.delete();

  if (off) return { ...off, fallback: false };
  // Fallback: nominal GigaPan overlap
  return axis === 'h'
    ? { dx: Math.round(w * (1 - FALLBACK_OVERLAP)), dy: 0, inliers: 0, fallback: true }
    : { dx: 0, dy: Math.round(h * (1 - FALLBACK_OVERLAP)), inliers: 0, fallback: true };
}

// ---- compositing ---------------------------------------------

/**
 * Draw one frame with linear alpha feather on the interior edges
 * (edges that have a neighbor), then paint it onto the mosaic.
 */
function paintFeathered(ctx, cell, x, y, feather) {
  const { width: w, height: h } = cell.bitmap;
  const tmp = new OffscreenCanvas(w, h);
  const tctx = tmp.getContext('2d');
  tctx.drawImage(cell.bitmap, 0, 0);

  tctx.globalCompositeOperation = 'destination-out';
  const fade = (x0, y0, x1, y1, fw) => {
    if (fw < 2) return;
    const g = tctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    tctx.fillStyle = g;
    tctx.fillRect(0, 0, w, h);
  };
  if (feather.left) fade(0, 0, feather.left, 0, feather.left);
  if (feather.right) fade(w, 0, w - feather.right, 0, feather.right);
  if (feather.top) fade(0, 0, 0, feather.top, feather.top);
  if (feather.bottom) fade(0, h, 0, h - feather.bottom, feather.bottom);

  ctx.drawImage(tmp, Math.round(x), Math.round(y));
}

// ---- main pipeline -------------------------------------------

async function stitch({ cells, rows, cols, mode, focal35, jpegQuality }) {
  await loadOpenCV();

  // 0. Cylindrical pre-warp. Focal from Exif when available; without
  // it assume a 50mm-equivalent (a conservative, gentle curvature —
  // long GigaPan lenses barely bend either way).
  const f35 = focal35 ?? 50;
  progress(3, `Projecting ${cells.length} frame(s) onto the cylinder ` +
    `(${focal35 ? `Exif ${f35}mm equiv.` : 'no Exif focal — assuming 50mm equiv.'})…`);
  const mapCache = new Map(); // "w,h" → maps (all frames usually share one size)
  for (const cell of cells) {
    const { width: w, height: h } = cell.bitmap;
    const key = `${w},${h}`;
    if (!mapCache.has(key)) mapCache.set(key, cylMaps(w, h, w * f35 / 36));
    const warped = cylWarp(cell.bitmap, mapCache.get(key));
    cell.bitmap.close();
    cell.bitmap = warped; // OffscreenCanvas: same width/height/drawImage surface
  }
  for (const m of mapCache.values()) { m.mapX.delete(); m.mapY.delete(); }

  progress(5, 'Engine ready — matching features…');

  // Index cells by grid position
  const byPos = new Map();
  for (const c of cells) byPos.set(`${c.row},${c.col}`, c);
  const at = (r, c) => byPos.get(`${r},${c}`) ?? null;

  // 1–2. Pairwise offsets along shared edges
  const hOff = new Map(); // key "r,c" → offset of (r,c+1) relative to (r,c)
  const vOff = new Map(); // key "r,c" → offset of (r+1,c) relative to (r,c)
  const pairs = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (at(r, c) && at(r, c + 1)) pairs.push({ r, c, axis: 'h' });
      if (at(r, c) && at(r + 1, c)) pairs.push({ r, c, axis: 'v' });
    }
  }
  let done = 0, fallbacks = 0, inlierTotal = 0;
  for (const p of pairs) {
    const a = at(p.r, p.c);
    const b = p.axis === 'h' ? at(p.r, p.c + 1) : at(p.r + 1, p.c);
    const off = pairOffset(a, b, p.axis);
    (p.axis === 'h' ? hOff : vOff).set(`${p.r},${p.c}`, off);
    if (off.fallback) fallbacks++; else inlierTotal += off.inliers;
    done++;
    progress(5 + Math.round((done / pairs.length) * 60),
      `Matching pair ${done}/${pairs.length}${off.fallback ? ' (fallback)' : ''}`);
  }

  // 3. Integrate into absolute positions (average left/top constraints)
  progress(68, 'Solving layout…');
  const pos = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = at(r, c);
      if (!cell) continue;
      const cands = [];
      const left = at(r, c - 1);
      if (left && pos.has(left.id) && hOff.has(`${r},${c - 1}`)) {
        const o = hOff.get(`${r},${c - 1}`);
        const p = pos.get(left.id);
        cands.push({ x: p.x + o.dx, y: p.y + o.dy });
      }
      const top = at(r - 1, c);
      if (top && pos.has(top.id) && vOff.has(`${r - 1},${c}`)) {
        const o = vOff.get(`${r - 1},${c}`);
        const p = pos.get(top.id);
        cands.push({ x: p.x + o.dx, y: p.y + o.dy });
      }
      if (!cands.length) {
        // First cell, or an island with no solved neighbors
        cands.push({
          x: c * cell.bitmap.width * (1 - FALLBACK_OVERLAP),
          y: r * cell.bitmap.height * (1 - FALLBACK_OVERLAP),
        });
      }
      pos.set(cell.id, {
        x: cands.reduce((s, p) => s + p.x, 0) / cands.length,
        y: cands.reduce((s, p) => s + p.y, 0) / cands.length,
      });
    }
  }

  // 3b. Global relaxation: the row-major pass above accumulates error
  // along its traversal order; iterating a weighted average over ALL
  // pair constraints (matched pairs count fully, fallbacks barely)
  // distributes the residuals evenly instead of piling them up in the
  // last row/column.
  const constraints = []; // {aId, bId, dx, dy, w}
  for (const [key, o] of hOff) {
    const [r, c] = key.split(',').map(Number);
    constraints.push({ a: at(r, c).id, b: at(r, c + 1).id, dx: o.dx, dy: o.dy, w: o.fallback ? 0.2 : 1 });
  }
  for (const [key, o] of vOff) {
    const [r, c] = key.split(',').map(Number);
    constraints.push({ a: at(r, c).id, b: at(r + 1, c).id, dx: o.dx, dy: o.dy, w: o.fallback ? 0.2 : 1 });
  }
  const anchorId = cells[0].id;
  for (let it = 0; it < RELAX_ITERS; it++) {
    const acc = new Map(); // id → {x, y, w}
    const push = (id, x, y, w) => {
      const a = acc.get(id) ?? { x: 0, y: 0, w: 0 };
      a.x += x * w; a.y += y * w; a.w += w;
      acc.set(id, a);
    };
    for (const c of constraints) {
      const pa = pos.get(c.a), pb = pos.get(c.b);
      push(c.b, pa.x + c.dx, pa.y + c.dy, c.w);
      push(c.a, pb.x - c.dx, pb.y - c.dy, c.w);
    }
    for (const [id, a] of acc) {
      if (id === anchorId || !a.w) continue;
      pos.set(id, { x: a.x / a.w, y: a.y / a.w });
    }
  }

  // 4. Composite with feathering
  progress(72, 'Compositing…');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const cell of cells) {
    const p = pos.get(cell.id);
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + cell.bitmap.width);
    maxY = Math.max(maxY, p.y + cell.bitmap.height);
  }
  const mosaicW = Math.round(maxX - minX);
  const mosaicH = Math.round(maxY - minY);
  const mosaic = new OffscreenCanvas(mosaicW, mosaicH);
  const mctx = mosaic.getContext('2d');

  // Blend only a narrow band near each seam instead of the full
  // overlap: wide feathers turn any residual misalignment into a
  // large semi-transparent ghost zone, whereas beyond the band the
  // later-drawn frame simply covers its neighbor opaquely.
  const blendBand = (edgePx) => Math.min(Math.max(0.06 * edgePx, 16), 48);

  const featherFor = (r, c, cell) => {
    const f = { left: 0, right: 0, top: 0, bottom: 0 };
    const ov = (o, axis, dim) => Math.max(0, dim - Math.abs(axis === 'h' ? o.dx : o.dy));
    if (at(r, c - 1) && hOff.has(`${r},${c - 1}`)) {
      const overlap = ov(hOff.get(`${r},${c - 1}`), 'h', at(r, c - 1).bitmap.width);
      f.left = Math.min(overlap / 2, blendBand(cell.bitmap.width));
    }
    if (at(r, c + 1) && hOff.has(`${r},${c}`)) {
      const overlap = ov(hOff.get(`${r},${c}`), 'h', cell.bitmap.width);
      f.right = Math.min(overlap / 2, blendBand(cell.bitmap.width));
    }
    if (at(r - 1, c) && vOff.has(`${r - 1},${c}`)) {
      const overlap = ov(vOff.get(`${r - 1},${c}`), 'v', at(r - 1, c).bitmap.height);
      f.top = Math.min(overlap / 2, blendBand(cell.bitmap.height));
    }
    if (at(r + 1, c) && vOff.has(`${r},${c}`)) {
      const overlap = ov(vOff.get(`${r},${c}`), 'v', cell.bitmap.height);
      f.bottom = Math.min(overlap / 2, blendBand(cell.bitmap.height));
    }
    return f;
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = at(r, c);
      if (!cell) continue;
      const p = pos.get(cell.id);
      paintFeathered(mctx, cell, p.x - minX, p.y - minY, featherFor(r, c, cell));
    }
  }

  // 5. Output projection
  let out = mosaic;
  if (mode === 'equirectangular') {
    // Assume the mosaic spans 360° horizontally; pad/fit onto a 2:1 canvas.
    progress(88, 'Projecting to equirectangular (2:1)…');
    const outW = mosaicW;
    const outH = Math.round(outW / 2);
    out = new OffscreenCanvas(outW, outH);
    const octx = out.getContext('2d');
    if (mosaicH <= outH) {
      octx.drawImage(mosaic, 0, Math.round((outH - mosaicH) / 2));
    } else {
      const s = outH / mosaicH;
      const w = Math.round(mosaicW * s);
      octx.drawImage(mosaic, Math.round((outW - w) / 2), 0, w, outH);
    }
  }

  progress(94, 'Encoding JPEG…');
  const blob = await out.convertToBlob({ type: 'image/jpeg', quality: jpegQuality ?? 0.92 });

  for (const c of cells) c.bitmap.close?.(); // OffscreenCanvas has no close()
  postMessage({
    type: 'done',
    blob,
    width: out.width,
    height: out.height,
    mode,
    pairStats: {
      pairs: pairs.length, fallbacks, inlierTotal,
      focal35: f35, focalFromExif: Boolean(focal35),
    },
  });
}

self.onmessage = (e) => {
  if (e.data?.type !== 'stitch') return;
  stitch(e.data).catch((err) => {
    postMessage({ type: 'error', message: err?.message ?? String(err) });
  });
};
