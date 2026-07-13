// =========================================================
// GigaPanoStitcher — Exif GPS / timestamp parsing (Phase 3)
// =========================================================
// Reads DateTimeOriginal and GPS from every loaded JPEG via
// exifr (loaded from CDN as window.exifr). Per the spec, the
// shooting location shown on the map is taken from the photo
// with the LATEST capture timestamp that carries a GPS fix —
// a GigaPan run can drift, so the final frame is closest to
// where the rig actually stood when the capture finished.
//
// All coordinates are WGS84 (EPSG:4326), as stored in Exif.

import { state, on, emit, setLocation } from './state.js';
import { DEFAULT_LOCATION } from './config.js';

/* global exifr */

// One parse promise per entry so other modules can AWAIT metadata
// instead of racing it (e.g. the stitcher needs focal35 before its
// cylindrical warp — an unset value must mean "no Exif", never
// "Exif not read yet").
const parsePromises = new Map(); // entry.id → Promise<void>

/** Parse one entry (idempotent — one shared promise per entry). */
function parseEntry(entry) {
  if (!parsePromises.has(entry.id)) {
    entry.exifParsed = true;
    parsePromises.set(entry.id, doParse(entry));
  }
  return parsePromises.get(entry.id);
}

/** Await Exif metadata for the given entries (parses if needed). */
export function ensureExifParsed(entries) {
  return Promise.all(entries.map(parseEntry));
}

async function doParse(entry) {
  try {
    const [meta, gps] = await Promise.all([
      exifr.parse(entry.file, {
        pick: ['DateTimeOriginal', 'CreateDate', 'FocalLengthIn35mmFormat'],
      }),
      exifr.gps(entry.file),
    ]);
    entry.takenAt = meta?.DateTimeOriginal ?? meta?.CreateDate ?? null;
    // 35mm-equivalent focal length drives the cylindrical pre-warp
    entry.focal35 = Number.isFinite(meta?.FocalLengthIn35mmFormat)
      ? meta.FocalLengthIn35mmFormat : null;
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
      entry.gps = { lat: gps.latitude, lng: gps.longitude };
    }
  } catch {
    // No Exif / unreadable Exif — entry simply has no metadata.
  }
}

/**
 * Among images with a GPS fix, pick the one captured last.
 * When every GPS image carries a timestamp the latest one wins;
 * if any lacks a timestamp, timestamps can't order the set
 * reliably, so the whole selection falls back to load order.
 * @returns {?{lat: number, lng: number}}
 */
export function lastCapturedGps() {
  const withGps = state.images.filter((e) => e.gps);
  if (!withGps.length) return null;
  const allTimed = withGps.every((e) => e.takenAt);
  let best = withGps[0];
  for (const e of withGps.slice(1)) {
    const later = allTimed
      ? e.takenAt.getTime() > best.takenAt.getTime()
        || (e.takenAt.getTime() === best.takenAt.getTime() && e.seq > best.seq)
      : e.seq > best.seq;
    if (later) best = e;
  }
  return best.gps;
}

/** Re-evaluate the map location whenever the image set changes. */
function applyLocation() {
  // Never override a position the user placed by hand.
  if (state.locationSource === 'user') return;
  const gps = lastCapturedGps();
  if (gps) {
    setLocation(gps.lat, gps.lng, 'exif');
  } else if (state.locationSource === 'exif') {
    // The photo the marker came from is gone — don't keep stale coords.
    setLocation(DEFAULT_LOCATION.lat, DEFAULT_LOCATION.lng, 'default');
  }
}

export function initExif() {
  on('images', async (images) => {
    const fresh = images.filter((e) => !e.exifParsed);
    if (fresh.length) {
      await Promise.all(fresh.map(parseEntry));
      emit('exif', fresh);
    }
    // Runs on deletions too: the Exif-selected photo may have been removed.
    applyLocation();
  });
}
