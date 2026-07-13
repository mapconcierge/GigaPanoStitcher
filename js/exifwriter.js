// =========================================================
// PanoramaStitcher — dependency-free Exif APP1 builder
// =========================================================
// Replaces piexifjs for WRITING. The export path must not depend on
// a CDN script: a blocked/miscached piexif.min.js left `piexif`
// undefined in the field and killed export preparation entirely
// ("Export preparation failed: piexif is not defined" on Pages).
//
// Builds a complete APP1 segment (marker + "Exif\0\0" + big-endian
// TIFF block) carrying:
//   IFD0    : Software, pointers to Exif IFD & GPS IFD
//   Exif IFD: DateTimeOriginal (when known)
//   GPS IFD : version, lat/lng with refs, WGS-84 datum
// Layout is computed programmatically; entries are tag-sorted as the
// TIFF spec requires. All values big-endian ("MM").

// TIFF field types
const ASCII = 2;    // 1 byte / char, NUL-terminated
const LONG = 4;     // 4-byte unsigned
const RATIONAL = 5; // 2×4-byte unsigned (numerator, denominator)
const BYTE = 1;

/** degrees → [[d,1],[m,1],[s*10000,10000]] */
function degToDms(deg) {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = Math.round(((abs - d) * 60 - m) * 60 * 10000);
  return [[d, 1], [m, 1], [s, 10000]];
}

/**
 * One IFD entry before layout: {tag, type, values}
 *   ASCII    values: string (NUL added here)
 *   LONG     values: [n]
 *   BYTE     values: [b,b,b,b] (≤4, packed inline)
 *   RATIONAL values: [[num,den], ...]
 */
function entryBytes(type, values) {
  if (type === ASCII) return values.length + 1;
  if (type === LONG) return 4 * values.length;
  if (type === BYTE) return values.length;
  return 8 * values.length; // RATIONAL
}

/**
 * Serialize IFDs into a TIFF block. `ifds` is an array of entry
 * arrays IN FILE ORDER: [ifd0, exifIfd?, gpsIfd?]. Pointer entries in
 * ifd0 are patched via `pointers`: {tag → ifds index}.
 * @returns {Uint8Array} the TIFF block (starts with "MM")
 */
function buildTiff(ifds, pointers) {
  // ---- layout pass: IFD table offsets, then data-area offsets
  const HDR = 8;
  const tableSize = (ifd) => 2 + ifd.length * 12 + 4;
  const ifdOffsets = [];
  let cursor = HDR;
  for (const ifd of ifds) {
    ifdOffsets.push(cursor);
    cursor += tableSize(ifd);
  }
  // data area
  for (const ifd of ifds) {
    for (const e of ifd) {
      const n = entryBytes(e.type, e.values);
      if (n > 4) {
        e.dataOffset = cursor;
        cursor += n + (n % 2); // keep offsets even
      }
    }
  }

  const buf = new Uint8Array(cursor);
  const dv = new DataView(buf.buffer);
  // TIFF header
  buf[0] = 0x4d; buf[1] = 0x4d;         // "MM" big-endian
  dv.setUint16(2, 0x002a);
  dv.setUint32(4, HDR);                  // IFD0 offset

  const writeValues = (e, at) => {
    if (e.type === ASCII) {
      for (let i = 0; i < e.values.length; i++) buf[at + i] = e.values.charCodeAt(i) & 0x7f;
      buf[at + e.values.length] = 0;
    } else if (e.type === LONG) {
      e.values.forEach((v, i) => dv.setUint32(at + 4 * i, v));
    } else if (e.type === BYTE) {
      e.values.forEach((v, i) => { buf[at + i] = v; });
    } else { // RATIONAL
      e.values.forEach(([num, den], i) => {
        dv.setUint32(at + 8 * i, num);
        dv.setUint32(at + 8 * i + 4, den);
      });
    }
  };

  ifds.forEach((ifd, idx) => {
    const sorted = [...ifd].sort((a, b) => a.tag - b.tag);
    let at = ifdOffsets[idx];
    dv.setUint16(at, sorted.length);
    at += 2;
    for (const e of sorted) {
      // resolve IFD-pointer entries now that offsets are known
      if (pointers.has(e.tag)) e.values = [ifdOffsets[pointers.get(e.tag)]];
      const count = e.type === ASCII ? e.values.length + 1 : e.values.length;
      dv.setUint16(at, e.tag);
      dv.setUint16(at + 2, e.type);
      dv.setUint32(at + 4, count);
      const n = entryBytes(e.type, e.values);
      if (n > 4) {
        dv.setUint32(at + 8, e.dataOffset);
        writeValues(e, e.dataOffset);
      } else {
        writeValues(e, at + 8); // packed inline, left-justified
      }
      at += 12;
    }
    dv.setUint32(at, 0); // no next IFD
  });
  return buf;
}

/**
 * Build a full APP1 segment (FF E1 …) for the given metadata.
 * @param {{lat: number, lng: number, dateTimeOriginal: ?string, software: string}} meta
 * @returns {Uint8Array}
 */
export function buildExifApp1({ lat, lng, dateTimeOriginal, software }) {
  const gpsIfd = [
    { tag: 0x0000, type: BYTE, values: [2, 3, 0, 0] },                    // GPSVersionID
    { tag: 0x0001, type: ASCII, values: lat >= 0 ? 'N' : 'S' },           // GPSLatitudeRef
    { tag: 0x0002, type: RATIONAL, values: degToDms(lat) },               // GPSLatitude
    { tag: 0x0003, type: ASCII, values: lng >= 0 ? 'E' : 'W' },           // GPSLongitudeRef
    { tag: 0x0004, type: RATIONAL, values: degToDms(lng) },               // GPSLongitude
    { tag: 0x0012, type: ASCII, values: 'WGS-84' },                        // GPSMapDatum
  ];
  const exifIfd = dateTimeOriginal
    ? [{ tag: 0x9003, type: ASCII, values: dateTimeOriginal }]             // DateTimeOriginal
    : null;

  const ifd0 = [
    { tag: 0x0131, type: ASCII, values: software },                        // Software
    { tag: 0x8825, type: LONG, values: [0] },                              // → GPS IFD
  ];
  const ifds = [ifd0];
  const pointers = new Map();
  if (exifIfd) {
    ifd0.push({ tag: 0x8769, type: LONG, values: [0] });                   // → Exif IFD
    ifds.push(exifIfd);
    pointers.set(0x8769, 1);
  }
  ifds.push(gpsIfd);
  pointers.set(0x8825, ifds.length - 1);

  const tiff = buildTiff(ifds, pointers);
  const head = new TextEncoder().encode('Exif\0\0');
  const payloadLen = head.length + tiff.length;
  const seg = new Uint8Array(4 + payloadLen);
  seg[0] = 0xff; seg[1] = 0xe1;
  seg[2] = ((payloadLen + 2) >> 8) & 0xff;
  seg[3] = (payloadLen + 2) & 0xff;
  seg.set(head, 4);
  seg.set(tiff, 4 + head.length);
  return seg;
}
