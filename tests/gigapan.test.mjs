import { buildGrid } from '../js/gigapan.js';

const imgs = (n) => Array.from({ length: n }, (_, i) => ({ id: `${i + 1}` }));

function show(name, opts, n = opts.rows * opts.cols) {
  const { grid, overflow } = buildGrid(imgs(n), opts);
  console.log(`\n${name}`);
  for (const row of grid) console.log('  ' + row.map((v) => (v ?? '.').padStart(3)).join(''));
  if (overflow.length) console.log('  overflow:', overflow.join(','));
  return grid;
}

const base = { rows: 3, cols: 4, order: 'azimuth-first', direction: 'cw', scan: 'parallel', startRow: 'top' };

let g;
// 1. Raster CW top: rows fill top→bottom, each row left→right
g = show('azimuth-first / cw / parallel / top', base);
console.assert(g[0].join() === '1,2,3,4' && g[2].join() === '9,10,11,12', 'FAIL 1');

// 2. Zigzag: second row reversed
g = show('azimuth-first / cw / zigzag / top', { ...base, scan: 'zigzag' });
console.assert(g[0].join() === '1,2,3,4' && g[1].join() === '8,7,6,5' && g[2].join() === '9,10,11,12', 'FAIL 2');

// 3. CCW: columns fill right→left
g = show('azimuth-first / ccw / parallel / top', { ...base, direction: 'ccw' });
console.assert(g[0].join() === '4,3,2,1', 'FAIL 3');

// 4. Bottom start: first pass is bottom row
g = show('azimuth-first / cw / parallel / bottom', { ...base, startRow: 'bottom' });
console.assert(g[2].join() === '1,2,3,4' && g[0].join() === '9,10,11,12', 'FAIL 4');

// 5. Elevation-first CW top: columns fill left→right, each column top→bottom
g = show('elevation-first / cw / parallel / top', { ...base, order: 'elevation-first' });
console.assert(g[0].join() === '1,4,7,10' && g[2].join() === '3,6,9,12', 'FAIL 5');

// 6. Elevation-first zigzag: 2nd column bottom→top
g = show('elevation-first / cw / zigzag / top', { ...base, order: 'elevation-first', scan: 'zigzag' });
console.assert(g[0].join() === '1,6,7,12' && g[2].join() === '3,4,9,10', 'FAIL 6');

// 7. Overflow: more images than cells
const r = buildGrid(imgs(14), base);
console.assert(r.overflow.join() === '13,14', 'FAIL 7');
console.log('\noverflow test: ok →', r.overflow.join(','));

// 8. Partial fill: fewer images than cells → trailing nulls
g = show('partial fill (10 of 12)', base, 10);
console.assert(g[2].join() === '9,10,,', 'FAIL 8');

console.log('\nAll assertions passed.');
