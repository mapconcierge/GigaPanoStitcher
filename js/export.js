// =========================================================
// PanoramaStitcher — export: Exif injection + KML PhotoOverlay
// =========================================================
// The stitched JPEG gets the (possibly user-corrected) shooting
// location written into its Exif GPS tags via piexifjs, plus a
// Software tag and the capture time of the source set.
//
// With the KML option enabled, the download is a .kmz —
// a zip holding doc.kml (a <PhotoOverlay>) and files/<jpg> —
// which opens directly in Google Earth. Otherwise a plain .jpg.
//
// Coordinates are WGS84 (EPSG:4326) — Exif GPS and KML both use it.

import { state, on } from './state.js';

/* global piexif, JSZip */

const downloadBtn = document.getElementById('download-btn');
const downloadPngBtn = document.getElementById('download-png-btn');
const kmlCheckbox = document.getElementById('kml-checkbox');
const statusEl = document.getElementById('export-status');

const setStatus = (msg) => { statusEl.textContent = msg; };

// ---- Exif ----------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

/** Latest capture time among the source images, as an Exif string. */
function sourceCaptureTime() {
  const times = state.images.map((e) => e.takenAt).filter(Boolean);
  if (!times.length) return null;
  const d = new Date(Math.max(...times.map((t) => t.getTime())));
  return `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Inject the marker position (+ metadata) into the stitched JPEG.
 *
 * piexif.dump builds only the (sub-kilobyte) Exif payload string; the
 * APP1 segment is then spliced into the JPEG at the byte level via
 * Blob composition. piexif.insert would instead round-trip the WHOLE
 * multi-megabyte JPEG through JS binary strings — hundreds of MB of
 * peak memory on real panoramas, which is exactly the kind of load
 * that made the export die silently on some machines.
 */
export async function injectExif(blob) {
  const { lat, lng } = state.location;

  const zeroth = {};
  zeroth[piexif.ImageIFD.Software] = 'PanoramaStitcher';

  const exif = {};
  const dto = sourceCaptureTime();
  if (dto) exif[piexif.ExifIFD.DateTimeOriginal] = dto;

  const gps = {};
  gps[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? 'N' : 'S';
  gps[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lat));
  gps[piexif.GPSIFD.GPSLongitudeRef] = lng >= 0 ? 'E' : 'W';
  gps[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lng));
  gps[piexif.GPSIFD.GPSMapDatum] = 'WGS-84';

  // "Exif\0\0" + TIFF block, as a small binary string → bytes
  const payloadStr = piexif.dump({ '0th': zeroth, 'Exif': exif, 'GPS': gps });
  const payload = new Uint8Array(payloadStr.length);
  for (let i = 0; i < payloadStr.length; i++) payload[i] = payloadStr.charCodeAt(i) & 0xff;

  // APP1 header: marker FF E1 + big-endian length (payload + the 2 length bytes)
  const segLen = payload.length + 2;
  const header = new Uint8Array([0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff]);

  // Sanity: canvas encoders emit SOI first (FF D8); splice right after it
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] !== 0xff || head[1] !== 0xd8) {
    throw new Error('Stitched blob is not a JPEG (missing SOI marker)');
  }
  return new Blob([head, header, payload, blob.slice(2)], { type: 'image/jpeg' });
}

// ---- KML PhotoOverlay ----------------------------------------

/**
 * KML PhotoOverlay document. Equirectangular panoramas become a
 * full spherical overlay; rectangles a flat one with a modest FOV.
 * @param {string} jpgHref path of the image inside the KMZ
 */
export function buildKml(jpgHref, name) {
  const { lat, lng } = state.location;
  const sphere = state.result?.mode === 'equirectangular';
  const vv = sphere
    ? { left: -180, right: 180, bottom: -90, top: 90, shape: 'sphere' }
    : { left: -30, right: 30, bottom: -20, top: 20, shape: 'rectangle' };
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <PhotoOverlay>
    <name>${name}</name>
    <Camera>
      <longitude>${lng}</longitude>
      <latitude>${lat}</latitude>
      <altitude>2</altitude>
      <heading>0</heading>
      <tilt>90</tilt>
      <roll>0</roll>
      <altitudeMode>relativeToGround</altitudeMode>
    </Camera>
    <Icon>
      <href>${jpgHref}</href>
    </Icon>
    <ViewVolume>
      <leftFov>${vv.left}</leftFov>
      <rightFov>${vv.right}</rightFov>
      <bottomFov>${vv.bottom}</bottomFov>
      <topFov>${vv.top}</topFov>
      <near>10</near>
    </ViewVolume>
    <Point>
      <coordinates>${lng},${lat},0</coordinates>
    </Point>
    <shape>${vv.shape}</shape>
  </PhotoOverlay>
</kml>
`;
}

// ---- download ------------------------------------------------

function stampName() {
  const d = new Date();
  return `panorama_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
         `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

// Every export artifact (Exif JPEG, KMZ, PNG) is built AHEAD of the
// click and armed onto a real <a download> anchor. The user's click
// is then a plain native link download with zero JavaScript in the
// activation path. A programmatic a.click(), which earlier versions
// used, is silently swallowed by some browsers/extensions — the app
// saw "success" while no file ever landed (the GitHub Pages bug).
let exportName = '';
let urls = { main: null, png: null }; // armed object URLs
let prepToken = 0;

function disarm(anchor) {
  anchor.removeAttribute('href');
  anchor.removeAttribute('download');
  anchor.setAttribute('aria-disabled', 'true');
}

function arm(anchor, blob, filename) {
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = filename;
  anchor.removeAttribute('aria-disabled');
  return url;
}

function revokeArmed() {
  for (const k of Object.keys(urls)) {
    if (urls[k]) URL.revokeObjectURL(urls[k]);
    urls[k] = null;
  }
}

/** Arm the main anchor: plain JPEG, or KMZ when the KML box is on. */
async function armMainAnchor(jpeg) {
  if (kmlCheckbox.checked) {
    const zip = new JSZip();
    zip.file('doc.kml', buildKml(`files/${exportName}.jpg`, exportName));
    // STORE: JPEG doesn't deflate — keeps KMZ generation fast
    zip.folder('files').file(`${exportName}.jpg`, jpeg, { compression: 'STORE' });
    const kmz = await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.google-earth.kmz',
    });
    return arm(downloadBtn, kmz, `${exportName}.kmz`);
  }
  return arm(downloadBtn, jpeg, `${exportName}.jpg`);
}

/** PNG re-encoded from the displayed result canvas (no Exif in PNG). */
function resultPngBlob() {
  const canvas = document.getElementById('result-canvas');
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
}

let preparedJpeg = null; // kept for KMZ re-arming on checkbox toggle

async function prepareExports() {
  // Invalidate synchronously: stale artifacts from a previous result
  // or marker position must never stay downloadable.
  preparedJpeg = null;
  disarm(downloadBtn);
  disarm(downloadPngBtn);
  revokeArmed();
  if (!state.result) return;
  const token = ++prepToken;
  exportName = stampName();
  setStatus('Preparing export…');
  try {
    const jpeg = await injectExif(state.result.blob);
    if (token !== prepToken) return;
    preparedJpeg = jpeg;
    urls.main = await armMainAnchor(jpeg);
    if (token !== prepToken) return;
    setStatus(`Ready to download (${(jpeg.size / 1024 / 1024).toFixed(1)} MB JPEG). Encoding PNG…`);

    const png = await resultPngBlob(); // slow for large panoramas
    if (token !== prepToken) return;
    urls.png = arm(downloadPngBtn, png, `${exportName}.png`);
    setStatus(`Ready to download — JPEG ${(jpeg.size / 1024 / 1024).toFixed(1)} MB / ` +
              `PNG ${(png.size / 1024 / 1024).toFixed(1)} MB (PNG carries no Exif GPS).`);
  } catch (err) {
    if (token === prepToken) setStatus(`Export preparation failed: ${err.message}`);
  }
}

export function initExport() {
  on('result', prepareExports);
  // Marker moved after stitching → the Exif coordinates must follow
  on('location', () => { if (state.result) prepareExports(); });

  // KML toggle swaps the main anchor between .jpg and .kmz
  kmlCheckbox.addEventListener('change', async () => {
    if (!preparedJpeg) return;
    disarm(downloadBtn);
    if (urls.main) { URL.revokeObjectURL(urls.main); urls.main = null; }
    try {
      urls.main = await armMainAnchor(preparedJpeg);
    } catch (err) {
      setStatus(`Export preparation failed: ${err.message}`);
    }
  });

  // Native downloads need no JS — these only update the status line
  downloadBtn.addEventListener('click', () => {
    if (downloadBtn.hasAttribute('href')) setStatus(`Saved ${downloadBtn.download}.`);
  });
  downloadPngBtn.addEventListener('click', () => {
    if (downloadPngBtn.hasAttribute('href')) setStatus(`Saved ${downloadPngBtn.download}.`);
  });
}
