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
const kmlCheckbox = document.getElementById('kml-checkbox');
const statusEl = document.getElementById('export-status');

const setStatus = (msg) => { statusEl.textContent = msg; };

// ---- binary helpers (piexifjs works on binary strings) -------

const CHUNK = 0x8000;

function blobToBinaryString(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return bin;
}

function binaryStringToBlob(bin, type) {
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

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

/** Inject the marker position (+ metadata) into the stitched JPEG. */
export async function injectExif(blob) {
  const bin = blobToBinaryString(await blob.arrayBuffer());
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

  const exifBytes = piexif.dump({ '0th': zeroth, 'Exif': exif, 'GPS': gps });
  return binaryStringToBlob(piexif.insert(exifBytes, bin), 'image/jpeg');
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

function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function stampName() {
  const d = new Date();
  return `panorama_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
         `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

// The Exif-injected JPEG is prepared ahead of time (when a result
// lands or the marker moves) so the click handler can hand the file
// to the browser while the user gesture is still "fresh" — browsers
// drop programmatic downloads whose transient activation expired,
// which is exactly what happened when a large panorama spent seconds
// inside piexif before the a.click().
let prepared = null; // Exif-injected JPEG blob
let prepToken = 0;

async function prepareJpeg() {
  if (!state.result) { prepared = null; return null; }
  const token = ++prepToken;
  try {
    const jpeg = await injectExif(state.result.blob);
    if (token !== prepToken) return null; // superseded meanwhile
    prepared = jpeg;
    setStatus(`Ready to download (${Math.round(jpeg.size / 1024 / 1024 * 10) / 10} MB).`);
    return jpeg;
  } catch (err) {
    if (token === prepToken) {
      prepared = null;
      setStatus(`Export preparation failed: ${err.message}`);
    }
    return null;
  }
}

async function download() {
  if (!state.result) return;
  try {
    const name = stampName();
    // Use the pre-built JPEG when available; only rebuild if the
    // preparation is still running or previously failed.
    const jpeg = prepared ?? await prepareJpeg();
    if (!jpeg) return; // prepareJpeg already reported the error

    if (kmlCheckbox.checked) {
      const zip = new JSZip();
      zip.file('doc.kml', buildKml(`files/${name}.jpg`, name));
      // STORE: JPEG doesn't deflate — skipping compression keeps the
      // KMZ generation fast enough to stay inside the gesture window.
      zip.folder('files').file(`${name}.jpg`, jpeg, { compression: 'STORE' });
      const kmz = await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/vnd.google-earth.kmz',
      });
      triggerDownload(kmz, `${name}.kmz`);
      setStatus(`Saved ${name}.kmz — open it in Google Earth.`);
    } else {
      triggerDownload(jpeg, `${name}.jpg`);
      setStatus(`Saved ${name}.jpg.`);
    }
  } catch (err) {
    setStatus(`Download failed: ${err.message}`);
  }
}

export function initExport() {
  downloadBtn.addEventListener('click', download);
  on('result', () => {
    downloadBtn.disabled = false;
    setStatus('Preparing export…');
    prepareJpeg();
  });
  // Marker moved after stitching → the Exif coordinates must follow
  on('location', () => { if (state.result) prepareJpeg(); });
}
