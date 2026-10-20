/**
 * Visual check: art vs result with the v3 engine (full-canvas target + search).
 * Usage: node test/repro.js
 */
'use strict';
const fs = require('fs');
const P = require('./../core.js');
const URL = 'https://USER.github.io';
const N = 29;

function blank(fill) { return Array.from({ length: N }, () => fill.repeat(N)); }
function setPx(rows, x, y, ch) {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  rows[y] = rows[y].substring(0, x) + ch + rows[y].substring(x + 1);
}
function rect(rows, x0, y0, x1, y1, ch) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setPx(rows, x, y, ch);
}
function disk(rows, cx, cy, r, ch) {
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy <= r * r) setPx(rows, x, y, ch);
  }
}
function ring(rows, cx, cy, r, ch) {
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x - cx, dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= r && d > r - 1.6) setPx(rows, x, y, ch);
  }
}

const cases = {};
{
  const rows = blank('.');
  rect(rows, 9, 6, 11, 22, '#'); rect(rows, 17, 6, 19, 22, '#'); rect(rows, 12, 13, 16, 15, '#');
  cases.H = rows;
}
{
  const rows = blank('.'); disk(rows, 14, 14, 8, '#'); cases.disk = rows;
}
{
  const rows = blank('.'); ring(rows, 14, 14, 9, '#'); cases.ring = rows;
}
{
  const rows = blank('.');
  disk(rows, 10, 12, 1.8, '#'); disk(rows, 18, 12, 1.8, '#');
  for (let x = 8; x <= 20; x++) {
    const y = 20 - Math.round(Math.sqrt(Math.max(0, 36 - (x - 14) * (x - 14))) / 2.5);
    setPx(rows, x, y + 2, '#');
  }
  cases.smiley = rows;
}
cases.cat = P.TEMPLATE_ROWS.CAT;

function ascii(art, target, modules, n) {
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

const report = [];
for (const [name, rows] of Object.entries(cases)) {
  const art = P.artFromRows(rows);
  const t0 = Date.now();
  const fit = P.optimizeEncoding(URL, 3, art, {});
  const searchMs = Date.now() - t0;
  const base = fit.base;
  const t = P.autoTune(base, art, { strength: 1.0, margin: 1.0, plan: fit.plan });

  // metrics
  let inkTotal = 0, inkOn = 0, bgTotal = 0, bgOn = 0, inkConf = 0, inkConfFixed = 0;
  for (let i = 0; i < N * N; i++) {
    if (base.func[i]) continue;
    const isInk = art[i] === 1;
    if (isInk) { inkTotal++; if (t.modules[i]) inkOn++; if (!base.modules[i]) { inkConf++; if (t.modules[i]) inkConfFixed++; } }
    else { bgTotal++; if (t.modules[i]) bgOn++; }
  }
  const inkFill = (100 * inkOn / inkTotal).toFixed(0);
  const bgFill = (100 * bgOn / bgTotal).toFixed(0);

  report.push({
    name, suffix: fit.suffix || '(none)', mask: fit.mask, searchMs,
    flips: t.flips, cwUsed: t.cwUsed + '/' + t.cwBudget, verified: t.verified,
    ink: inkTotal, inkFill: inkFill + '%', bgFill: bgFill + '%',
    contrast: (inkFill - bgFill) + 'pp', inkRealized: (100 * t.inkRealized).toFixed(0) + '%'
  });

  // save art + result for the PNG sheet
  fs.writeFileSync('/tmp/opencode/v2_' + name + '.art', Buffer.from(art));
  const img = P.renderRGBA(t.modules, N, 16, 4);
  fs.writeFileSync('/tmp/opencode/v2_' + name + '.raw', Buffer.from(img.data.buffer));
  fs.writeFileSync('/tmp/opencode/v2_' + name + '.meta', JSON.stringify({ w: img.width }));

  console.log('=== ' + name + ' (fit: ' + (fit.suffix || 'none') + ', mask ' + fit.mask +
    ', search ' + searchMs + 'ms) ==========================');
  console.log(ascii(art, null, t.modules, N));
}

console.log('\n== summary ==');
console.table(report);

// quick A/B on ink emphasis
console.log('\n== inkBoost A/B (cat, smiley) ==');
for (const burden of [1.0, 1.4]) {
  const parts = [];
  for (const name of ['cat', 'smiley']) {
    const art = P.artFromRows(cases[name]);
    const fit = P.optimizeEncoding(URL, 3, art, { inkBoost: burden });
    const t = P.autoTune(fit.base, art, { strength: 1.0, margin: 1.0, plan: fit.plan });
    let inkTotal = 0, inkOn = 0, bgTotal = 0, bgOn = 0;
    for (let i = 0; i < N * N; i++) {
      if (fit.base.func[i]) continue;
      if (art[i] === 1) { inkTotal++; if (t.modules[i]) inkOn++; }
      else { bgTotal++; if (t.modules[i]) bgOn++; }
    }
    parts.push(name + ': ink ' + (100 * inkOn / inkTotal).toFixed(0) + '% bg ' +
      (100 * bgOn / bgTotal).toFixed(0) + '% flips ' + t.flips);
  }
  console.log('  inkBoost ' + burden + ' -> ' + parts.join('  |  '));
}
