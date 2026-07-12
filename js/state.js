// =========================================================
// PanoramaStitcher — central application state
// =========================================================
// Single mutable store + a tiny pub/sub so UI modules stay
// decoupled. No framework: subscribers re-render themselves.

import { DEFAULT_LOCATION } from './config.js';

/**
 * @typedef {Object} ImageEntry
 * @property {string}  id         Stable unique id
 * @property {File}    file       Original File object
 * @property {string}  url        Object URL for thumbnail / processing
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
    seq: state.images.length + 0, // placeholder; fixed below
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
  for (const e of state.images) URL.revokeObjectURL(e.url);
  state.images = [];
  state.grid = null;
  emit('images', state.images);
  emit('grid', state.grid);
}

/** Update the shooting location (map marker drag, Exif, Geolocation). */
export function setLocation(lat, lng, source) {
  state.location = { lat, lng };
  state.locationSource = source;
  emit('location', { ...state.location, source });
}
