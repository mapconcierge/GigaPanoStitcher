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

async function download() {
  if (!state.result) return;
  downloadBtn.disabled = true;
  const label = downloadBtn.textContent;
  downloadBtn.textContent = 'Preparing…';
  try {
    const name = stampName();
    const jpeg = await injectExif(state.result.blob);
    if (kmlCheckbox.checked) {
      const zip = new JSZip();
      zip.file('doc.kml', buildKml(`files/${name}.jpg`, name));
      zip.folder('files').file(`${name}.jpg`, jpeg);
      const kmz = await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/vnd.google-earth.kmz',
      });
      triggerDownload(kmz, `${name}.kmz`);
    } else {
      triggerDownload(jpeg, `${name}.jpg`);
    }
  } finally {
    downloadBtn.textContent = label;
    downloadBtn.disabled = false;
  }
}

export function initExport() {
  downloadBtn.addEventListener('click', download);
  on('result', () => { downloadBtn.disabled = false; });
}
