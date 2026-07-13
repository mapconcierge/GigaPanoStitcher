// =========================================================
// GigaPanoStitcher — central application state
// =========================================================
// Single mutable store + a tiny pub/sub so UI modules stay
// decoupled. No framework: subscribers re-render themselves.

import { DEFAULT_LOCATION } from './config.js';

/**
 * @typedef {Object} ImageEntry
 * @property {string}  id         Stable unique id
 * @property {File}    file       Original File object
 * @property {string}  url        Object URL of the original file
 * @property {?string} thumbUrl   Object URL of the downscaled thumbnail
 * @property {number}  seq        Sequence index at load time (file order)
 * @property {?Date}   takenAt    Exif DateTimeOriginal (Phase 3)
 * @property {?{lat:number,lng:number}} gps  Exif GPS (Phase 3)
 */

export const state = {
  /** @type {ImageEntry[]} loaded images in capture sequence */
  images: [],

  /** Matrix layout: grid[row][col] = ImageEntry.id | null (Phase 2) */
  grid: null,
  rows: 1,
  cols: 1,

  /** Shooting location shown on the map (WGS84 / EPSG:4326). */
  location: { ...DEFAULT_LOCATION },
  /** Where the location came from: 'default' | 'exif' | 'geolocation' | 'user' */
  locationSource: 'default',

  /** Stitch result (Phase 4). */
  result: null, // { blob, width, height, mode }
};

// ---- pub/sub -------------------------------------------------

const listeners = new Map(); // event -> Set<fn>

/** Subscribe to a state event ('images', 'grid', 'location', 'result'). */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

/** Notify subscribers of a state event. */
export function emit(event, payload) {
  for (const fn of listeners.get(event) ?? []) fn(payload);
}

// ---- mutations -----------------------------------------------

let nextId = 1;

/**
 * Append loaded files as ImageEntries (capped upstream at MAX_IMAGES).
 * @param {File[]} files
 * @returns {ImageEntry[]} the entries that were added
 */
export function addImages(files) {
  const added = files.map((file) => ({
    id: `img-${nextId++}`,
    file,
    url: URL.createObjectURL(file),
    thumbUrl: null,
    seq: state.images.length + 0, // placeholder; fixed below
    exifParsed: false,
    takenAt: null,
    gps: null,
  }));
  added.forEach((e, i) => { e.seq = state.images.length + i; });
  state.images.push(...added);
  emit('images', state.images);
  return added;
}

/** Remove every image and revoke object URLs. */
export function clearImages() {
  for (const e of state.images) {
    URL.revokeObjectURL(e.url);
    if (e.thumbUrl) URL.revokeObjectURL(e.thumbUrl);
  }
  state.images = [];
  state.grid = null;
  emit('images', state.images);
  emit('grid', state.grid);
}

/** Look up an ImageEntry by id. */
export function getImage(id) {
  return state.images.find((e) => e.id === id) ?? null;
}

/** Replace the whole grid (Arrange button). */
export function setGrid(grid, rows, cols) {
  state.grid = grid;
  state.rows = rows;
  state.cols = cols;
  emit('grid', state.grid);
}

/** Ids currently placed in the grid. */
function placedIds() {
  const ids = new Set();
  for (const row of state.grid ?? []) {
    for (const id of row) if (id) ids.add(id);
  }
  return ids;
}

/** Images not placed in the grid (shown in the tray). */
export function trayImages() {
  if (!state.grid) return [];
  const placed = placedIds();
  return state.images.filter((e) => !placed.has(e.id));
}

/**
 * Move an image into a cell. If the cell is occupied the two images
 * swap (cell↔cell) or the occupant returns to the tray (tray→cell).
 * @param {string} id            image being dropped
 * @param {number} row @param {number} col  target cell
 */
export function placeImage(id, row, col) {
  if (!state.grid) return;
  const target = state.grid[row][col];
  if (target === id) return;

  // Where is the dropped image now?
  let from = null;
  outer: for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      if (state.grid[r][c] === id) { from = { r, c }; break outer; }
    }
  }

  state.grid[row][col] = id;
  if (from) state.grid[from.r][from.c] = target; // swap keeps both placed
  emit('grid', state.grid);
}

/** Remove an image from its cell (it returns to the tray). */
export function unplaceImage(row, col) {
  if (!state.grid || state.grid[row][col] === null) return;
  state.grid[row][col] = null;
  emit('grid', state.grid);
}

/** Delete an image from the app entirely (grid, tray and file list). */
export function deleteImage(id) {
  const entry = getImage(id);
  if (!entry) return;
  URL.revokeObjectURL(entry.url);
  if (entry.thumbUrl) URL.revokeObjectURL(entry.thumbUrl);
  state.images = state.images.filter((e) => e.id !== id);
  if (state.grid) {
    for (const row of state.grid) {
      for (let c = 0; c < row.length; c++) if (row[c] === id) row[c] = null;
    }
  }
  emit('images', state.images);
  if (state.grid) emit('grid', state.grid);
}

/** Update the shooting location (map marker drag, Exif, Geolocation). */
export function setLocation(lat, lng, source) {
  state.location = { lat, lng };
  state.locationSource = source;
  emit('location', { ...state.location, source });
}
