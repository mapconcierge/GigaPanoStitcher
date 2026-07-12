// =========================================================
// PanoramaStitcher — GigaPan shooting-pattern → grid logic
// =========================================================
// Maps a capture-sequence index k (0-based, file order) to a
// (row, col) cell in the panorama grid.
//
// Orthogonal parameter model (no redundant combinations):
//   order     azimuth-first  → the head sweeps a full row, then steps tilt
//             elevation-first→ the head sweeps a full column, then steps pan
//   direction cw  → azimuth increases → columns fill left → right
//             ccw → columns fill right → left
//   startRow  top / bottom → rows fill top → bottom or bottom → top
//   scan      parallel → every pass restarts from the same side (raster)
//             zigzag   → every other pass runs the primary axis in reverse

import { CaptureOrder, Direction, ScanPattern, StartRow } from './config.js';

/**
 * @typedef {Object} PatternOptions
 * @property {number} rows
 * @property {number} cols
 * @property {string} order      CaptureOrder.*
 * @property {string} direction  Direction.*
 * @property {string} scan       ScanPattern.*
 * @property {string} startRow   StartRow.*
 */

/**
 * Grid cell for the k-th image in the capture sequence.
 * @param {number} k 0-based sequence index
 * @param {PatternOptions} opts
 * @returns {{row: number, col: number}}
 */
export function gridPosition(k, opts) {
  const { rows, cols, order, direction, scan, startRow } = opts;
  const azimuthFirst = order === CaptureOrder.AZIMUTH_FIRST;
  const primaryLen = azimuthFirst ? cols : rows;

  const pass = Math.floor(k / primaryLen);
  let pos = k % primaryLen;
  if (scan === ScanPattern.ZIGZAG && pass % 2 === 1) pos = primaryLen - 1 - pos;

  let row = azimuthFirst ? pass : pos;
  let col = azimuthFirst ? pos : pass;

  if (direction === Direction.CCW) col = cols - 1 - col;
  if (startRow === StartRow.BOTTOM) row = rows - 1 - row;
  return { row, col };
}

/**
 * Arrange images into a rows×cols grid of image ids.
 * Images beyond rows*cols are returned as `overflow` (go to the tray).
 * @param {{id: string}[]} images in capture-sequence order
 * @param {PatternOptions} opts
 * @returns {{grid: (string|null)[][], overflow: string[]}}
 */
export function buildGrid(images, opts) {
  const { rows, cols } = opts;
  const grid = Array.from({ length: rows }, () => Array(cols).fill(null));
  const overflow = [];
  images.forEach((img, k) => {
    if (k < rows * cols) {
      const { row, col } = gridPosition(k, opts);
      grid[row][col] = img.id;
    } else {
      overflow.push(img.id);
    }
  });
  return { grid, overflow };
}
