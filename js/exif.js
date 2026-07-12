// =========================================================
// PanoramaStitcher — Exif GPS / timestamp parsing (Phase 3)
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

/* global exifr */

/** Parse one entry (idempotent — marks the entry as processed). */
async function parseEntry(entry) {
  entry.exifParsed = true;
  try {
    const [meta, gps] = await Promise.all([
      exifr.parse(entry.file, { pick: ['DateTimeOriginal', 'CreateDate'] }),
      exifr.gps(entry.file),
    ]);
    entry.takenAt = meta?.DateTimeOriginal ?? meta?.CreateDate ?? null;
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
      entry.gps = { lat: gps.latitude, lng: gps.longitude };
    }
  } catch {
    // No Exif / unreadable Exif — entry simply has no metadata.
  }
}

/**
 * Among images with a GPS fix, pick the one captured last.
 * Images without a timestamp sort by load sequence instead.
 * @returns {?{lat: number, lng: number}}
 */
export function lastCapturedGps() {
  const withGps = state.images.filter((e) => e.gps);
  if (!withGps.length) return null;
  withGps.sort((a, b) => {
    const ta = a.takenAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const tb = b.takenAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    return ta === tb ? a.seq - b.seq : ta - tb;
  });
  return withGps[withGps.length - 1].gps;
}

/** Re-evaluate the map location after a batch finished parsing. */
function applyLocation() {
  // Never override a position the user placed by hand.
  if (state.locationSource === 'user') return;
  const gps = lastCapturedGps();
  if (gps) setLocation(gps.lat, gps.lng, 'exif');
}

export function initExif() {
  on('images', async (images) => {
    const fresh = images.filter((e) => !e.exifParsed);
    if (!fresh.length) return;
    await Promise.all(fresh.map(parseEntry));
    emit('exif', fresh);
    applyLocation();
  });
}
