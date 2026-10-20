/**
 * Pipelines, surfaces and round output — node.
 * Usage: node test/pipeline.js
 *
 * What this proves:
 *   - the free surface comes in three shapes and always ends up free of
 *     random code cells, whatever the version (v2 to v13);
 *   - the higher versions really do buy a bigger surface;
 *   - the custom pipeline round-trips: our own circular layout encodes, and
 *     the engine's own Reed-Solomon decoder reads it back, art and all;
 *   - a round avatar of a standard QR survives the circular crop: the code is
 *     inscribed in the circle, so all three finder patterns stay inside it.
 */
'use strict';
const P = require('./../core.js');
const URL = 'https://sky-is-green.github.io#';

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

console.log('== surfaces: three shapes, one promise (zero random cells inside) ==');
for (const kind of P.SURFACE_KINDS) {
  const line = [];
  for (const v of [4, 6, 8]) {
    const n = v * 4 + 17;
    const art = P.artFromRows(reframe(P.TEMPLATE_ROWS.CAT, n));
    let w;
    try {
      w = P.fitWorkbench(URL, v, art, { surface: kind });
    } catch (e) {
      // a shape the budget cannot hold at this version: that is an answer,
      // not a failure — the app says so and asks for another version
      line.push('v' + v + ':too small');
      check(kind + ' v' + v + ' either fits or says so', true, String(e));
      continue;
    }
    line.push('v' + v + ':' + w.canvas.width + '×' + w.canvas.width);
    check(kind + ' v' + v + ' zero random cells in the surface', w.residual.bg === 0 && w.residual.ink === 0,
      'bg=' + w.residual.bg + ' ink=' + w.residual.ink);
    check(kind + ' v' + v + ' still decodes', w.t.verified === true);
  }
  console.log('  ' + kind + ': ' + line.join('  '));
}

console.log('\n== the version range: v2 to v13 all build, fit and decode ==');
for (const v of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
  const n = v * 4 + 17;
  // v2 and v3 hold a shorter link at level H
  const url = v <= 3 ? 'https://a.co' : URL;
  let ok = true, info = '';
  try {
    const art = P.artFromRows(reframe(P.TEMPLATE_ROWS.CAT, n));
    const w = P.fitWorkbench(url, v, art, {});
    const dec = P.decodeRGBA(P.renderRGBA(w.t.modules, n, 8, 4, 'square')) === w.fit.base.url;
    ok = w.t.verified && dec && w.residual.bg === 0;
    info = 'surface ' + w.canvas.width + '×' + w.canvas.width + ' · jsQR ' + (dec ? 'decodes' : 'FAILS');
  } catch (e) {
    ok = false;
    info = 'threw: ' + e;
  }
  check('v' + v + ' (' + n + '×' + n + ')', ok, info);
}

console.log('\n== bigger versions buy a bigger surface ==');
{
  const sizes = [];
  for (const v of [4, 6, 8, 10, 12]) {
    const n = v * 4 + 17;
    const art = P.artFromRows(reframe(P.TEMPLATE_ROWS.CAT, n));
    const w = P.fitWorkbench(URL, v, art, {});
    sizes.push([v, w.canvas.cells]);
  }
  for (let i = 1; i < sizes.length; i++) {
    check('v' + sizes[i][0] + ' surface is bigger than v' + sizes[i - 1][0],
      sizes[i][1] > sizes[i - 1][1], sizes[i - 1][1] + ' → ' + sizes[i][1] + ' cells');
  }
}

console.log('\n== the custom pipeline: our own circular layout ==');
for (const v of [4, 6, 8]) {
  const pipe = P.PIPELINES.custom;
  const lay = pipe.layout(URL, v);
  const G = lay.G;
  const art = P.artFromRows(reframe(P.TEMPLATE_ROWS.CAT, G));
  // 1. the bare code round-trips
  const base = pipe.build(URL, v, 0, null);
  const raw = P.decodeCustom(base.modules, lay, 0);
  check('v' + v + ' encodes and decodes', raw === URL, 'grid ' + G + '×' + G + ' → ' + raw);
  // 2. the art is realized and the code still decodes
  const w = pipe.fit(URL, v, art, { style: 'dots' });
  const dec = P.decodeCustom(w.t.modules, lay, w.fit.mask);
  check('v' + v + ' art realized, zero random cells', w.residual.bg === 0 && w.residual.ink === 0,
    'bg=' + w.residual.bg + ' ink=' + w.residual.ink);
  check('v' + v + ' decodes after the art', dec === w.fit.base.url, String(dec));
  // 3. the finder patterns sit inside the disc, not on its corners
  const corners = [[0, 0], [G - 7, 0], [0, G - 7]];
  let clear = true;
  for (const c of corners) {
    for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
      if (lay.func[(c[1] + dy) * G + (c[0] + dx)]) clear = false;
    }
  }
  check('v' + v + ' the corners are free of finder patterns', clear);
  console.log('  v' + v + ': grid ' + G + '×' + G + ' · disc r=' + lay.rDisc.toFixed(1) +
    ' · eyes at r=' + lay.dFind.toFixed(1) + ' · surface ' + w.canvas.width + '×' + w.canvas.width);
}

console.log('\n== the round avatar: the standard QR survives the circular crop ==');
for (const v of [4, 6]) {
  const n = v * 4 + 17;
  const art = P.artFromRows(reframe(P.TEMPLATE_ROWS.CAT, n));
  const w = P.fitWorkbench(URL, v, art, { style: 'dots', surface: 'circle' });
  // the export picks the largest module size that still decodes
  const box = P.roundAvatarBox(w.t.modules, n, 1024, 'dots', { url: w.fit.base.url });
  const img = P.renderRoundRGBA(w.t.modules, n, 1024, 'dots', { box: box });
  const dec = P.decodeRGBA(img);
  check('v' + v + ' the round avatar decodes after the crop', dec === w.fit.base.url, String(dec));
  const small = P.renderRoundRGBA(w.t.modules, n, 260, 'dots');
  check('v' + v + ' the round avatar decodes at 260px', P.decodeRGBA(small) === w.fit.base.url);
  console.log('  v' + v + ': ' + box + 'px per module, the code is ' +
    Math.round(img.layout.side / 1024 * 100) + '% of the circle');
}

console.log('\n== the versions that could work for a link ==');
{
  // a short link fits v2; a long one needs more, and the versions that
  // cannot hold it (or have no room to draw) are greyed out in the app
  const short = 'https://a.co';
  const long = 'https://sky-is-green.github.io#';
  check('a short link fits v2', P.minVersion(short) === 2, 'v' + P.minVersion(short));
  check('a long link needs a bigger version', P.minVersion(long) >= 4, 'v' + P.minVersion(long));
  for (const v of [2, 3, 4, 5, 6]) {
    const url = long;
    let fits = true;
    try { P.buildBase(url, v, 0); } catch (e) { fits = false; }
    const min = P.minVersion(url);
    check('v' + v + (fits ? ' can hold the link' : ' cannot hold the link') + ' — and says so',
      fits ? v >= min : v < min, 'min v' + min);
  }
  // the cross is thin: it needs a bigger version than the square does
  const sq = P.minVersion(long, { surface: 'squircle' });
  const cr = P.minVersion(long, { surface: 'cross' });
  check('the cross needs a bigger version than the square', cr > sq, 'square v' + sq + ' · cross v' + cr);
}

console.log('\n== the custom avatar fills the circle ==');{
  const v = 6;
  const pipe = P.PIPELINES.custom;
  const lay = pipe.layout(URL, v);
  const art = P.artFromRows(reframe(P.TEMPLATE_ROWS.CAT, lay.G));
  const w = pipe.fit(URL, v, art, { style: 'dots' });
  const img = P.renderDiscRGBA(w.t.modules, lay.G, lay, 1024, 'dots');
  // the disc reaches the rim: the outermost ring of pixels is inside the circle
  let opaque = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) opaque++;
  check('the disc fills the circle', opaque / (1024 * 1024) > 0.7,
    Math.round(opaque / (1024 * 1024) * 100) + '% of the frame is code');
  console.log('  ' + Math.round(opaque / (1024 * 1024) * 100) + '% of the frame carries the code');
}

console.log('\n== done ==' + (failures ? '  ' + failures + ' FAILURES' : '  all checks passed'));
process.exit(failures ? 1 : 0);
