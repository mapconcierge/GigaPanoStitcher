// =========================================================
// PanoramaStitcher — constants & enums
// =========================================================

/** Maximum number of input images. */
export const MAX_IMAGES = 100;

/** Accepted MIME types (GigaPan rigs produce JPEG). */
export const ACCEPTED_TYPES = ['image/jpeg'];

/** Default map location: Tokyo Station (WGS84 / EPSG:4326). */
export const DEFAULT_LOCATION = { lat: 35.681236, lng: 139.767125 };

/** Default map zoom when no GPS fix is available. */
export const DEFAULT_ZOOM = 15;

/** Zoom used once a GPS position (Exif or Geolocation) is known. */
export const LOCATED_ZOOM = 17;

/** GigaPan capture-order enums (used by gigapan.js in Phase 2). */
export const CaptureOrder = Object.freeze({
  AZIMUTH_FIRST: 'azimuth-first',     // sweep a row, then step elevation
  ELEVATION_FIRST: 'elevation-first', // sweep a column, then step azimuth
});

export const Direction = Object.freeze({
  CW: 'cw',    // left → right (azimuth increases)
  CCW: 'ccw',  // right → left
});

export const ScanPattern = Object.freeze({
  PARALLEL: 'parallel', // every pass starts from the same side (raster)
  ZIGZAG: 'zigzag',     // alternating passes (serpentine)
});

export const StartCorner = Object.freeze({
  TOP_LEFT: 'top-left',
  TOP_RIGHT: 'top-right',
  BOTTOM_LEFT: 'bottom-left',
  BOTTOM_RIGHT: 'bottom-right',
});

/** Output projection modes for the stitcher (Phase 4). */
export const OutputMode = Object.freeze({
  EQUIRECTANGULAR: 'equirectangular',
  RECTANGLE: 'rectangle',
});
