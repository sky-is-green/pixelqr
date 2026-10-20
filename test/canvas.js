/**
 * Writable-canvas checks — node.
 * Usage: node test/canvas.js
 *
 * The workbench promise: inside the writable canvas there is ZERO random QR
 * signal — every cell matches the drawing (background light, ink dark), while
 * the code's own randomness lives only in the ring outside. This script
 * measures the achieved canvas per version, verifies the zero-residual
 * promise, and decodes the result (styles × sizes) to confirm it scans.
 */
'use strict';
const P = require('./../core.js');
const URL = 'https://USER.github.io';

let failures = 0;
function check(name, cond, info) {
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + ' ' + name + (info !== undefined ? '  [' + info + ']' : ''));
  if (!cond) failures++;
}
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
function blank(n) { return Array.from({ length: n }, () => '.'.repeat(n)); }
function bbox(rows) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows.length; x++) {
      if (rows[y][x] === '#') {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

console.log('== canvas geometry per version (' + URL + ', ' + URL.length + ' chars) ==');
const shapes = {};
for (const v of [3, 4, 5, 6]) {
  const sh = P.canvasShape(URL, v);
  shapes[v] = sh;
  console.log('  v' + v + ' (' + (v * 4 + 17) + '×' + (v * 4 + 17) + '): canvas ' +
    sh.width + '×' + sh.width + '  cells=' + sh.cells + '  cwBudget=' + sh.cwBudget + '  padBits=' + sh.padBits);
}

console.log('\n== fit: canvas promise (zero residual) ==');
const presetNames = Object.keys(P.TEMPLATE_ROWS);
for (const name of presetNames) {
  const bb = bbox(P.TEMPLATE_ROWS[name]);
  console.log('  ' + name + ' bbox: ' + bb.w + '×' + bb.h);
}
for (const v of [3, 4, 5, 6]) {
  const n = v * 4 + 17;
  const cases = [['blank', blank(n)]];
  for (const name of presetNames) cases.push([name.toLowerCase(), reframe(P.TEMPLATE_ROWS[name], n)]);
  for (const [name, rows] of cases) {
    const art = P.artFromRows(rows);
    const t0 = Date.now();
    const w = P.fitWorkbench(URL, v, art, {});
    const ms = Date.now() - t0;
    const r = w.residual;
    console.log('  v' + v + ' ' + name.padEnd(5) + ': canvas ' + w.canvas.width + '×' + w.canvas.width +
      '  residual bg=' + r.bg + ' ink=' + r.ink +
      '  attempts=' + w.attempts + '  cw=' + w.t.cwUsed + '/' + w.t.cwBudget +
      '  padFix=' + (w.fit.pad ? w.fit.pad.fixed : 0) +
      '  verified=' + w.t.verified + '  ' + ms + 'ms');
    check('v' + v + ' ' + name + ' zero random cells in canvas', r.bg === 0, 'bg=' + r.bg);
    check('v' + v + ' ' + name + ' verified scan', w.t.verified === true);
  }
}
// app logic: pick the smallest version whose canvas fits the template
for (const name of presetNames) {
  const bb = bbox(P.TEMPLATE_ROWS[name]);
  const need = Math.max(bb.w, bb.h) + 2;
  let pick = 3;
  for (let v = 3; v <= 6; v++) { if (shapes[v].width >= need) { pick = v; break; } }
  console.log('  preset auto-fit: ' + name + ' (' + bb.w + ' wide, need ' + need + ') → v' + pick);
  check(name + ' auto-fits at v' + pick, shapes[pick].width >= need);
}

console.log('\n== decode battery on workbench results (styles × sizes) ==');
for (const v of [4, 5]) {
  const n = v * 4 + 17;
  for (const name of presetNames) {
    const art = P.artFromRows(reframe(P.TEMPLATE_ROWS[name], n));
    const w = P.fitWorkbench(URL, v, art, {});
    const url = w.fit.base.url;
    const line = [];
    for (const style of ['square', 'rounded', 'dots']) {
      const clean = P.decodeRGBA(P.renderRGBA(w.t.modules, n, 8, 4, style)) === url;
      const stressed = P.decodeRGBA(P.blurRGBA(P.renderRGBA(w.t.modules, n, 4, 4, style))) === url;
      line.push(style + ':' + (clean ? 'C' : '-') + (stressed ? 'B' : '-'));
      check('v' + v + ' ' + name + ' ' + style + ' decodes', clean && stressed);
    }
    console.log('  v' + v + ' ' + name.toLowerCase() + ': ' + line.join('  '));
  }
}

console.log('\n== reuse fast path (painting) ==');
{
  const v = 5, n = v * 4 + 17;
  const art = P.artFromRows(reframe(P.TEMPLATE_ROWS.CAT, n));
  const w1 = P.fitWorkbench(URL, v, art, {});
  const t0 = Date.now();
  const w2 = P.fitWorkbench(URL, v, art, { reuse: { mask: w1.fit.mask, suffix: w1.fit.suffix } });
  const ms = Date.now() - t0;
  console.log('  reuse: same mask=' + (w2.fit.mask === w1.fit.mask) + ' same suffix=' + (w2.fit.suffix === w1.fit.suffix) +
    ' residual bg=' + w2.residual.bg + ' verified=' + w2.t.verified + '  ' + ms + 'ms');
  check('reuse zero residual', w2.residual.bg === 0 && w2.residual.ink === 0);
  check('reuse verified', w2.t.verified === true);
}

console.log('\n== done ==' + (failures ? '  ' + failures + ' FAILURES' : '  all checks passed'));
process.exit(failures ? 1 : 0);
