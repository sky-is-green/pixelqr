/**
 * Cat template workbench: builds a coordinate-specified cat, runs it through
 * the engine (with center-focus), prints art vs result + flip partition +
 * region metrics, saves PNGs. Usage: node test/catgen.js
 */
'use strict';
const fs = require('fs');
const P = require('./../core.js');
const URL = 'https://USER.github.io';
const N = 29;

function blank() { return Array.from({ length: N }, () => '.'.repeat(N)); }
function setPx(rows, x, y, ch) {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  rows[y] = rows[y].substring(0, x) + ch + rows[y].substring(x + 1);
}
function mirror(x) { return 28 - x; }

const rows = blank();

// ---- ears (5 rows tall, bold, with inner-ear light slit) ----
const earCoords = [
  [10, 7],
  [9, 8], [10, 8], [11, 8],
  [8, 9], [9, 9], [10, 9], [11, 9], [12, 9],
  [7, 10], [8, 10], [9, 10], [10, 10], [11, 10], [12, 10], [13, 10],
  [7, 11], [8, 11], [9, 11], [10, 11], [11, 11], [12, 11], [13, 11]
];
earCoords.forEach(([x, y]) => { setPx(rows, x, y, '#'); setPx(rows, mirror(x), y, '#'); });
[[9, 9], [9, 10]].forEach(([x, y]) => { setPx(rows, x, y, '.'); setPx(rows, mirror(x), y, '.'); });

// ---- eyes (6x4 oval, 2-cell glint) ----
const eyeCoords = [
  [8, 13], [9, 13], [10, 13], [11, 13],
  [7, 14], [8, 14], [9, 14], [10, 14], [11, 14], [12, 14],
  [7, 15], [8, 15], [9, 15], [10, 15], [11, 15], [12, 15],
  [8, 16], [9, 16], [10, 16], [11, 16]
];
eyeCoords.forEach(([x, y]) => { setPx(rows, x, y, '#'); setPx(rows, mirror(x), y, '#'); });
[[8, 14], [8, 15]].forEach(([x, y]) => { setPx(rows, x, y, '.'); setPx(rows, mirror(x), y, '.'); });

// ---- nose (chunky triangle) ----
[[13, 17], [14, 17], [15, 17], [13, 18], [14, 18], [15, 18], [14, 19]].forEach(([x, y]) => setPx(rows, x, y, '#'));

// ---- mouth (omega ω) ----
[[12, 20], [14, 20], [16, 20], [13, 21], [15, 21]].forEach(([x, y]) => setPx(rows, x, y, '#'));

// ---- render through engine ----
const art = P.artFromRows(rows);
const fit = P.optimizeEncoding(URL, 3, art, {});
const t = P.autoTune(fit.base, art, { strength: 1.0, margin: 1.0, plan: fit.plan });
const plan = fit.plan, base = fit.base;

function ascii(art, modules, n) {
  let out = '';
  for (let y = 0; y < n; y++) {
    let left = '', right = '';
    for (let x = 0; x < n; x++) {
      const a = art[y * n + x];
      left += a === 1 ? '\u2588' : a === 0 ? '\u2591' : ' ';
      right += modules[y * n + x] ? '\u2588' : ' ';
    }
    out += left + ' | ' + right + '\n';
  }
  return out;
}

// metrics
function regionDens(mod, sel, skipInk) {
  let tot = 0, on = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    if (base.func[i]) continue;
    if (skipInk && art[i] === 1) continue;
    const central = x >= 6 && x <= 22 && y >= 6 && y <= 22;
    if (central !== sel) continue;
    tot++; if (mod[i]) on++;
  }
  return { pct: (100 * on / tot).toFixed(0) + '%', tot };
}
let inkCw = 0, bgCw = 0, fixInk = 0, centerFix = 0, periFix = 0;
plan.selected.forEach(c => {
  const bits = plan.byCw[c].bits;
  if (bits.some(i => art[i] === 1)) inkCw++; else bgCw++;
  bits.forEach(i => {
    if (art[i] === 1) fixInk++;
    else { const x = i % N, y = (i / N) | 0; (x >= 6 && x <= 22 && y >= 6 && y <= 22) ? centerFix++ : periFix++; }
  });
});
let inkT = 0, inkOn = 0;
for (let i = 0; i < N * N; i++) { if (!base.func[i] && art[i] === 1) { inkT++; if (t.modules[i]) inkOn++; } }

const cB = regionDens(base.modules, true, true), pB = regionDens(base.modules, false, true);
const cF = regionDens(t.modules, true, true), pF = regionDens(t.modules, false, true);
console.log('fit:', fit.suffix || 'none', 'mask', fit.mask, '| flips', t.flips, '| verified', t.verified);
console.log('ink realized:', inkOn + '/' + inkT, '| selected cw:', plan.selected.length, '= ink-CW', inkCw, '+ bg-CW', bgCw);
console.log('flips: ink', fixInk, '| center-bg', centerFix, '| periphery-bg', periFix, '| free', plan.freeFlips.length);
console.log('center bg density:', cB.pct, '->', cF.pct, '(' + cB.tot + ' cells) | periphery bg density:', pB.pct, '->', pF.pct, '(' + pB.tot + ' cells)');
console.log(ascii(art, t.modules, N));

fs.writeFileSync('/tmp/opencode/cat_new.art', Buffer.from(art));
const img = P.renderRGBA(t.modules, N, 16, 4);
fs.writeFileSync('/tmp/opencode/cat_new.raw', Buffer.from(img.data.buffer));
fs.writeFileSync('/tmp/opencode/cat_new.meta', JSON.stringify({ w: img.width }));
