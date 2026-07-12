// =========================================================
// PanoramaStitcher — stitching controller (main thread)
// =========================================================
// Prepares downscaled ImageBitmaps from the arranged grid,
// hands them to the worker (transferable, zero-copy), and
// renders progress + the finished panorama.

import { state, on, emit, getImage } from './state.js';

const stitchBtn = document.getElementById('stitch-btn');
const modeSelect = document.getElementById('mode-select');
const resSelect = document.getElementById('resolution-select');
const progressEl = document.getElementById('stitch-progress');
const statusEl = document.getElementById('stitch-status');
const resultBox = document.getElementById('result-container');
const resultCanvas = document.getElementById('result-canvas');
const engineChip = document.getElementById('engine-status');

let worker = null;
let busy = false;

function setChip(text, cls) {
  engineChip.textContent = `Engine: ${text}`;
  engineChip.className = `status-chip ${cls}`;
}

/**
 * Processing size (longest edge, px). 'auto' shrinks with the image
 * count so a 100-frame set doesn't exhaust browser memory.
 */
function maxEdgeFor(count) {
  const v = resSelect.value;
  if (v !== 'auto') return v === 'full' ? Infinity : parseInt(v, 10);
  if (count <= 20) return 2048;
  if (count <= 50) return 1600;
  return 1200;
}

/** Decode one entry and downscale to maxEdge (aspect preserved). */
async function prepareBitmap(entry, maxEdge) {
  const full = await createImageBitmap(entry.file);
  if (Math.max(full.width, full.height) <= maxEdge) return full;
  const s = maxEdge / Math.max(full.width, full.height);
  const scaled = await createImageBitmap(full, {
    resizeWidth: Math.round(full.width * s),
    resizeHeight: Math.round(full.height * s),
    resizeQuality: 'high',
  });
  full.close();
  return scaled;
}

function getWorker() {
  if (!worker) {
    worker = new Worker('js/workers/stitch.worker.js');
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => finishWithError(e.message || 'Worker crashed');
  }
  return worker;
}

function onWorkerMessage({ data }) {
  if (data.type === 'progress') {
    progressEl.value = data.pct;
    statusEl.textContent = data.note;
  } else if (data.type === 'done') {
    showResult(data);
  } else if (data.type === 'error') {
    finishWithError(data.message);
  }
}

async function showResult({ blob, width, height, mode, pairStats }) {
  state.result = { blob, width, height, mode };
  const bmp = await createImageBitmap(blob);
  resultCanvas.width = width;
  resultCanvas.height = height;
  resultCanvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  resultBox.hidden = false;
  progressEl.value = 100;
  const quality = pairStats.fallbacks
    ? ` (${pairStats.fallbacks}/${pairStats.pairs} pair(s) used the fallback layout — check those seams)`
    : ` (${pairStats.pairs} pairs matched, ${pairStats.inlierTotal} inliers)`;
  statusEl.textContent =
    `Done: ${width}×${height}px ${mode === 'equirectangular' ? '360° equirectangular' : 'rectangle'}${quality}`;
  setChip('ready', 'status-ready');
  busy = false;
  stitchBtn.disabled = false;
  emit('result', state.result);
}

function finishWithError(message) {
  statusEl.textContent = `Stitching failed: ${message}`;
  progressEl.hidden = true;
  setChip('error', 'status-busy');
  busy = false;
  stitchBtn.disabled = false;
}

async function startStitch() {
  if (busy || !state.grid) return;
  busy = true;
  stitchBtn.disabled = true;
  resultBox.hidden = true;
  progressEl.hidden = false;
  progressEl.value = 0;
  setChip('busy', 'status-busy');

  try {
    // Collect placed cells in grid order
    const placed = [];
    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        const id = state.grid[r][c];
        if (!id) continue;
        const entry = getImage(id);
        if (entry) placed.push({ entry, row: r, col: c });
      }
    }
    if (placed.length < 2) {
      throw new Error('Place at least 2 images in the grid before stitching.');
    }

    // Decode sequentially to keep peak memory bounded
    const maxEdge = maxEdgeFor(placed.length);
    const cells = [];
    for (let i = 0; i < placed.length; i++) {
      statusEl.textContent = `Preparing image ${i + 1}/${placed.length}…`;
      progressEl.value = Math.round((i / placed.length) * 4);
      const bitmap = await prepareBitmap(placed[i].entry, maxEdge);
      cells.push({ id: placed[i].entry.id, row: placed[i].row, col: placed[i].col, bitmap });
    }

    statusEl.textContent = 'Loading stitching engine (OpenCV.js WASM, ~10 MB on first run)…';
    getWorker().postMessage(
      {
        type: 'stitch',
        cells,
        rows: state.rows,
        cols: state.cols,
        mode: modeSelect.value,
        jpegQuality: 0.92,
      },
      cells.map((c) => c.bitmap), // transfer, zero-copy
    );
  } catch (err) {
    finishWithError(err.message);
  }
}

export function initStitch() {
  stitchBtn.addEventListener('click', startStitch);

  on('grid', (grid) => {
    if (grid && !busy) stitchBtn.disabled = false;
  });
}
