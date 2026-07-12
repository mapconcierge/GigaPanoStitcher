// =========================================================
// PanoramaStitcher — entry point / orchestration
// =========================================================
// Phase 1: UI shell, upload intake, Leaflet map.
// Later phases plug in here:
//   Phase 2 → matrix.js / gigapan.js (grid arrangement)
//   Phase 3 → exif.js (GPS + timestamp → map)
//   Phase 4 → stitch.js (OpenCV.js WASM worker)
//   Phase 5 → export.js (Exif injection + KML PhotoOverlay)

import { initUpload } from './upload.js';
import { initMap } from './map.js';
import { state, on } from './state.js';

const applyMatrixBtn = document.getElementById('apply-matrix-btn');
const stitchStatus = document.getElementById('stitch-status');

function init() {
  initUpload();
  initMap();

  // Enable "Arrange grid" once images exist (handler lands in Phase 2)
  on('images', (images) => {
    applyMatrixBtn.disabled = images.length === 0;
    stitchStatus.textContent = images.length
      ? 'Arrange the grid, then stitching becomes available (Phase 4).'
      : 'Load and arrange images first.';
  });
}

document.addEventListener('DOMContentLoaded', init);
