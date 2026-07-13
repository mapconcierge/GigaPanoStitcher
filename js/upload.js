// =========================================================
// GigaPanoStitcher — drag-and-drop / file-picker intake
// =========================================================

import { MAX_IMAGES, ACCEPTED_TYPES, THUMB_SIZE } from './config.js';
import { state, addImages, on, emit } from './state.js';

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

/**
 * Generate a downscaled thumbnail for one entry (fire-and-forget).
 * Full-size GigaPan JPEGs are too heavy to decode 100× in the matrix.
 */
async function makeThumb(entry) {
  try {
    const bmp = await createImageBitmap(entry.file, {
      resizeWidth: THUMB_SIZE,
      resizeQuality: 'medium',
    });
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.75));
    if (blob) {
      entry.thumbUrl = URL.createObjectURL(blob);
      emit('thumb', entry);
    }
  } catch {
    // Corrupt/undecodable JPEG — the matrix falls back to the full-size URL.
  }
}

function handleFiles(fileList) {
  const { accepted, rejectedType, rejectedOverflow } = normalizeFiles(fileList);
  if (accepted.length) {
    const entries = addImages(accepted);
    entries.forEach(makeThumb);
  }

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

  // Global guard: a drop released outside the drop zone (map, panels, …)
  // must never navigate the page away. File drops anywhere are routed
  // into the uploader instead.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dropZone.contains(e.target) && e.dataTransfer?.files?.length) {
      handleFiles(e.dataTransfer.files);
    }
  });

  // Keep the summary line in sync with state
  on('images', () => { summary.textContent = summaryText(); });
}
