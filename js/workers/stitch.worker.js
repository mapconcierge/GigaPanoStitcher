// =========================================================
// PanoramaStitcher — stitching engine (Web Worker, Phase 4)
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
const ORB_FEATURES = 800;
/** Lowe ratio-test threshold. */
const RATIO = 0.75;
/** Minimum surviving matches for a pair offset to be trusted. */
const MIN_MATCHES = 8;
/** Assumed overlap fraction when matching fails (GigaPan default ~30%). */
const FALLBACK_OVERLAP = 0.3;

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

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Robust translation between two strips: median match delta with
 * one MAD-based rejection pass. Returns null when unreliable.
 * Deltas are expressed in GLOBAL frame coordinates of each image
 * (strip origins are added back by the caller via ax/ay/bx/by).
 */
function stripOffset(stripA, stripB, ax, ay, bx, by) {
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
        dxs.push((ax + pa.x) - (bx + pb.x));
        dys.push((ay + pa.y) - (by + pb.y));
      }
    }
    bf.delete(); knn.delete();

    if (dxs.length >= MIN_MATCHES) {
      // MAD outlier rejection, then re-median
      const mx = median(dxs), my = median(dys);
      const madX = median(dxs.map((v) => Math.abs(v - mx))) || 1;
      const madY = median(dys.map((v) => Math.abs(v - my))) || 1;
      const inX = [], inY = [];
      for (let i = 0; i < dxs.length; i++) {
        if (Math.abs(dxs[i] - mx) <= 3 * madX && Math.abs(dys[i] - my) <= 3 * madY) {
          inX.push(dxs[i]);
          inY.push(dys[i]);
        }
      }
      if (inX.length >= MIN_MATCHES) {
        result = { dx: median(inX), dy: median(inY), inliers: inX.length };
      }
    }
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
  const stripWA = Math.round((axis === 'h' ? a.bitmap.width : a.bitmap.height) * STRIP_FRAC);
  const stripWB = Math.round((axis === 'h' ? b.bitmap.width : b.bitmap.height) * STRIP_FRAC);
  let sa, sb, off = null;
  if (axis === 'h') {
    const ax = a.bitmap.width - stripWA;
    sa = matFromBitmap(a.bitmap, ax, 0, stripWA, a.bitmap.height);
    sb = matFromBitmap(b.bitmap, 0, 0, stripWB, b.bitmap.height);
    off = stripOffset(sa, sb, ax, 0, 0, 0);
  } else {
    const ay = a.bitmap.height - stripWA;
    sa = matFromBitmap(a.bitmap, 0, ay, a.bitmap.width, stripWA);
    sb = matFromBitmap(b.bitmap, 0, 0, b.bitmap.width, stripWB);
    off = stripOffset(sa, sb, 0, ay, 0, 0);
  }
  sa.delete(); sb.delete();

  if (off) return { ...off, fallback: false };
  // Fallback: nominal GigaPan overlap
  return axis === 'h'
    ? { dx: Math.round(a.bitmap.width * (1 - FALLBACK_OVERLAP)), dy: 0, inliers: 0, fallback: true }
    : { dx: 0, dy: Math.round(a.bitmap.height * (1 - FALLBACK_OVERLAP)), inliers: 0, fallback: true };
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

async function stitch({ cells, rows, cols, mode, jpegQuality }) {
  await loadOpenCV();
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

  const featherFor = (r, c, cell) => {
    const f = { left: 0, right: 0, top: 0, bottom: 0 };
    const ov = (o, axis, dim) => Math.max(0, dim - Math.abs(axis === 'h' ? o.dx : o.dy));
    if (at(r, c - 1) && hOff.has(`${r},${c - 1}`)) {
      f.left = ov(hOff.get(`${r},${c - 1}`), 'h', at(r, c - 1).bitmap.width) / 2;
    }
    if (at(r, c + 1) && hOff.has(`${r},${c}`)) {
      f.right = ov(hOff.get(`${r},${c}`), 'h', cell.bitmap.width) / 2;
    }
    if (at(r - 1, c) && vOff.has(`${r - 1},${c}`)) {
      f.top = ov(vOff.get(`${r - 1},${c}`), 'v', at(r - 1, c).bitmap.height) / 2;
    }
    if (at(r + 1, c) && vOff.has(`${r},${c}`)) {
      f.bottom = ov(vOff.get(`${r},${c}`), 'v', cell.bitmap.height) / 2;
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

  for (const c of cells) c.bitmap.close();
  postMessage({
    type: 'done',
    blob,
    width: out.width,
    height: out.height,
    mode,
    pairStats: { pairs: pairs.length, fallbacks, inlierTotal },
  });
}

self.onmessage = (e) => {
  if (e.data?.type !== 'stitch') return;
  stitch(e.data).catch((err) => {
    postMessage({ type: 'error', message: err?.message ?? String(err) });
  });
};
