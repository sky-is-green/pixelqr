/**
 * Style lab: renders the same fitted code through every candidate module style
 * and decodes each render with jsQR at decreasing sizes (plus blur). Reports
 * the pass matrix and dumps PNG-able raws for visual review.
 * Usage: node test/styles.js
 */
'use strict';
const fs = require('fs');
const P = require('./../core.js');
const URL = 'https://USER.github.io';

function reframe(rows, newN) {
  const oldN = rows.length;
  const off = Math.floor((newN - oldN) / 2);
  const out = [];
  for (let y = 0; y < newN; y++) {
    let row = '';
    for (let x = 0; x < newN; x++) {
      const oy = y - off, ox = x - off;
      row += (oy >= 0 && ox >= 0 && oy < oldN && ox < oldN) ? rows[oy][ox] : '.';
    }
    out.push(row);
  }
  return out;
}

const art = P.artFromRows(reframe(P.TEMPLATE_ROWS.CAT, 33));
const w = P.fitWorkbench(URL, 4, art, {});
const n = 33;
const url = w.fit.base.url;
console.log('fitted: canvas ' + w.canvas.width + '  residual bg=' + w.residual.bg + ' ink=' + w.residual.ink + '  url=' + url);

const styles = ['square', 'dots', 'squircle', 'hexagon', 'leaf', 'diamond'];
const sizes = [
  ['592', 16, false],
  ['444', 12, false],
  ['296', 8, false],
  ['222', 6, false],
  ['148b', 4, true],
  ['111b', 3, true]
];

const table = {};
for (const st of styles) {
  const row = [];
  for (const [, box, blur] of sizes) {
    let img = P.renderRGBA(w.t.modules, n, box, 4, st);
    if (blur) img = P.blurRGBA(img);
    row.push(P.decodeRGBA(img) === url);
  }
  table[st] = row;
}

console.log('\nstyle      ' + sizes.map(s => s[0].padStart(5)).join(''));
for (const st of styles) {
  const marks = table[st].map(v => (v ? 'ok' : '--').padStart(5));
  const exportGrade = table[st][1] && table[st][2] && table[st][4]; // 444 + 296 + 148b
  console.log(st.padEnd(10) + marks.join('') + '   ' + (exportGrade ? 'READY' : 'risky'));
}

for (const st of styles) {
  const img = P.renderRGBA(w.t.modules, n, 12, 4, st);
  fs.writeFileSync('/tmp/opencode/style_' + st + '.raw', Buffer.from(img.data.buffer));
  fs.writeFileSync('/tmp/opencode/style_' + st + '.meta', JSON.stringify({ w: img.width }));
}
console.log('\ndumped /tmp/opencode/style_*.raw (box 12)');
