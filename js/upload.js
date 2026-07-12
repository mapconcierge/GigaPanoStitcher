// =========================================================
// PanoramaStitcher — drag-and-drop / file-picker intake
// =========================================================

import { MAX_IMAGES, ACCEPTED_TYPES } from './config.js';
import { state, addImages, on } from './state.js';

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const summary = document.getElementById('upload-summary');

/** Filter to JPEGs, sort by name (GigaPan names are sequential), cap at MAX. */
function normalizeFiles(fileList) {
  const jpegs = [...fileList].filter(
    (f) => ACCEPTED_TYPES.includes(f.type) || /\.jpe?g$/i.test(f.name),
  );
  // GigaPan heads write sequential names — natural sort restores capture order
  jpegs.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );

  const room = MAX_IMAGES - state.images.length;
  const accepted = jpegs.slice(0, Math.max(room, 0));
  return {
    accepted,
    rejectedType: fileList.length - jpegs.length,
    rejectedOverflow: jpegs.length - accepted.length,
  };
}

function handleFiles(fileList) {
  const { accepted, rejectedType, rejectedOverflow } = normalizeFiles(fileList);
  if (accepted.length) addImages(accepted);

  const notes = [];
  if (rejectedType) notes.push(`${rejectedType} non-JPEG file(s) skipped`);
  if (rejectedOverflow) notes.push(`${rejectedOverflow} file(s) over the ${MAX_IMAGES}-image limit skipped`);
  if (notes.length) {
    summary.classList.add('warn');
    summary.textContent = `${summaryText()} — ${notes.join('; ')}.`;
  }
}

function summaryText() {
  const n = state.images.length;
  return n === 0 ? 'No images loaded.' : `${n} image(s) loaded (max ${MAX_IMAGES}).`;
}

export function initUpload() {
  // Click / keyboard opens the picker
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = ''; // allow re-selecting the same files
  });

  // Drag & drop
  for (const ev of ['dragenter', 'dragover']) {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    });
  }
  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });

  // Keep the summary line in sync with state
  on('images', () => { summary.textContent = summaryText(); });
}
