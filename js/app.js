// =========================================================
// GigaPanoStitcher — entry point / orchestration
// =========================================================
// Phase 1: UI shell, upload intake, Leaflet map.
// Later phases plug in here:
//   Phase 2 → matrix.js / gigapan.js (grid arrangement)
//   Phase 3 → exif.js (GPS + timestamp → map)
//   Phase 4 → stitch.js (OpenCV.js WASM worker)
//   Phase 5 → export.js (Exif injection + KML PhotoOverlay)

import { initUpload } from './upload.js';
import { initMap } from './map.js';
import { initMatrix } from './matrix.js';
import { initExif } from './exif.js';
import { initStitch } from './stitch.js';
import { initExport } from './export.js';
import { state, on } from './state.js';
import { APP_VERSION } from './config.js';

const applyMatrixBtn = document.getElementById('apply-matrix-btn');
const stitchStatus = document.getElementById('stitch-status');

function init() {
  document.getElementById('app-version').textContent = `v${APP_VERSION}`;
  initUpload();
  initMap();
  initMatrix();
  initExif();
  initStitch();
  initExport();

  on('images', (images) => {
    applyMatrixBtn.disabled = images.length === 0;
    if (!state.grid) {
      stitchStatus.textContent = images.length
        ? 'Arrange the grid to enable stitching.'
        : 'Load and arrange images first.';
    }
  });

  on('grid', (grid) => {
    if (!grid) return;
    const placed = grid.flat().filter(Boolean).length;
    stitchStatus.textContent =
      `Grid ${state.rows}×${state.cols} — ${placed} image(s) placed. Ready to stitch.`;
  });
}

document.addEventListener('DOMContentLoaded', init);
