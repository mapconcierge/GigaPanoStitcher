// =========================================================
// PanoramaStitcher — interactive thumbnail matrix UI
// =========================================================
// Renders state.grid as a CSS grid of thumbnail cells with
// row/column headers, plus a "tray" of unplaced images.
//
// Interactions:
//   drag cell → cell   swap the two images
//   drag tray → cell   place image (occupant returns to tray)
//   drag cell → tray   unplace image
//   ✕ on a thumbnail   delete the image from the app
//   click empty cell   no-op (drop target only)

import {
  state, on, getImage, setGrid, trayImages,
  placeImage, unplaceImage, deleteImage,
} from './state.js';
import { buildGrid } from './gigapan.js';

const container = document.getElementById('matrix-container');

const DND_TYPE = 'application/x-panostitcher-image-id';

// ---- helpers -------------------------------------------------

function readPatternOptions() {
  return {
    rows: Math.max(1, parseInt(document.getElementById('rows-input').value, 10) || 1),
    cols: Math.max(1, parseInt(document.getElementById('cols-input').value, 10) || 1),
    order: document.getElementById('order-select').value,
    direction: document.getElementById('direction-select').value,
    scan: document.getElementById('scan-select').value,
    startRow: document.getElementById('start-row-select').value,
  };
}

/** Build one draggable thumbnail element. */
function thumbEl(entry) {
  const wrap = document.createElement('div');
  wrap.className = 'thumb';
  wrap.draggable = true;
  wrap.dataset.imageId = entry.id;
  wrap.title = entry.file.name;

  const img = document.createElement('img');
  img.src = entry.thumbUrl ?? entry.url;
  img.alt = entry.file.name;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.draggable = false;
  wrap.appendChild(img);

  const name = document.createElement('span');
  name.className = 'thumb-name';
  name.textContent = entry.file.name;
  wrap.appendChild(name);

  const del = document.createElement('button');
  del.className = 'thumb-delete';
  del.textContent = '✕';
  del.title = 'Remove this image';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteImage(entry.id);
  });
  wrap.appendChild(del);

  wrap.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData(DND_TYPE, entry.id);
    e.dataTransfer.effectAllowed = 'move';
    wrap.classList.add('dragging');
  });
  wrap.addEventListener('dragend', () => wrap.classList.remove('dragging'));
  return wrap;
}

/** Wire a drop target. onDrop receives the dragged image id. */
function asDropTarget(el, onDrop) {
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes(DND_TYPE)) {
      e.preventDefault();
      e.stopPropagation(); // keep the global file-drop guard out of the way
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-hover');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', (e) => {
    if (!e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-hover');
    const id = e.dataTransfer.getData(DND_TYPE);
    if (id) onDrop(id);
  });
}

// ---- rendering -----------------------------------------------

function render() {
  container.textContent = '';

  if (!state.grid) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'The thumbnail matrix will appear here after images are loaded and arranged.';
    container.appendChild(p);
    return;
  }

  // Grid with headers: (cols+1) columns — corner + C1..Cn
  const gridEl = document.createElement('div');
  gridEl.className = 'matrix-grid';
  gridEl.style.gridTemplateColumns = `28px repeat(${state.cols}, var(--cell-size))`;

  gridEl.appendChild(headerCell('')); // corner
  for (let c = 0; c < state.cols; c++) gridEl.appendChild(headerCell(`C${c + 1}`));

  for (let r = 0; r < state.rows; r++) {
    gridEl.appendChild(headerCell(`R${r + 1}`));
    for (let c = 0; c < state.cols; c++) {
      const cell = document.createElement('div');
      cell.className = 'matrix-cell';
      const id = state.grid[r][c];
      if (id) {
        const entry = getImage(id);
        if (entry) cell.appendChild(thumbEl(entry));
        const seqBadge = document.createElement('span');
        seqBadge.className = 'seq-badge';
        seqBadge.textContent = `#${(entry?.seq ?? 0) + 1}`;
        seqBadge.title = 'Capture sequence number';
        cell.appendChild(seqBadge);
      } else {
        cell.classList.add('empty');
      }
      asDropTarget(cell, (droppedId) => placeImage(droppedId, r, c));
      // Double-click a filled cell to send it back to the tray
      if (id) cell.addEventListener('dblclick', () => unplaceImage(r, c));
      gridEl.appendChild(cell);
    }
  }
  container.appendChild(gridEl);

  // Tray of unplaced images
  const unplaced = trayImages();
  const tray = document.createElement('div');
  tray.className = 'matrix-tray';
  const label = document.createElement('div');
  label.className = 'tray-label';
  label.textContent = unplaced.length
    ? `Unplaced images (${unplaced.length}) — drag into the grid:`
    : 'Unplaced images: none — drag a thumbnail here to remove it from the grid.';
  tray.appendChild(label);
  const trayBody = document.createElement('div');
  trayBody.className = 'tray-body';
  for (const entry of unplaced) trayBody.appendChild(thumbEl(entry));
  tray.appendChild(trayBody);
  asDropTarget(tray, (droppedId) => {
    // Find the cell holding this id and clear it
    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        if (state.grid[r][c] === droppedId) { unplaceImage(r, c); return; }
      }
    }
  });
  container.appendChild(tray);
}

function headerCell(text) {
  const el = document.createElement('div');
  el.className = 'matrix-header';
  el.textContent = text;
  return el;
}

// ---- init ----------------------------------------------------

export function initMatrix() {
  const applyBtn = document.getElementById('apply-matrix-btn');
  const rowsInput = document.getElementById('rows-input');
  const colsInput = document.getElementById('cols-input');

  applyBtn.addEventListener('click', () => {
    const opts = readPatternOptions();
    const { grid } = buildGrid(state.images, opts);
    setGrid(grid, opts.rows, opts.cols);
  });

  // Suggest columns from the image count (on load and when rows change)
  const suggestCols = () => {
    if (!state.images.length) return;
    const rows = Math.max(1, parseInt(rowsInput.value, 10) || 1);
    colsInput.value = Math.ceil(state.images.length / rows);
  };
  on('images', suggestCols);
  rowsInput.addEventListener('input', suggestCols);

  on('grid', render);
  // Images added or deleted after the grid exists must show up in the
  // tray immediately (addImages only emits 'images', not 'grid')
  on('images', () => { if (state.grid) render(); });
  // Swap in generated thumbnails without a full re-render
  on('thumb', (entry) => {
    for (const el of container.querySelectorAll(`[data-image-id="${entry.id}"] img`)) {
      el.src = entry.thumbUrl;
    }
  });

  render();
}
