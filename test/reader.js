/**
 * The reader on its own — node suite.
 * Usage: node test/reader.js
 *
 * The reader is meant to stand by itself: someone who only wants to read our
 * codes should be able to take reader.js and nothing else. This builds a code
 * with the generator, then reads it back with the reader alone — the reader
 * never touches the generator's files.
 */
'use strict';
const path = require('path');
const P = require('../core.js');
const reader = require('../reader.js');

const URL = 'https://sky-is-green.github.io#';
let failures = 0;
function check(name, cond, info) {
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + ' ' + name + (info !== undefined ? '  [' + info + ']' : ''));
  if (!cond) failures++;
}
function reframe(rows, newN) {
  const oldN = rows.length, off = Math.floor((newN - oldN) / 2), out = [];
  for (let y = 0; y < newN; y++) {
    let r = '';
    for (let x = 0; x < newN; x++) {
      const oy = y - off, ox = x - off;
      r += (oy >= 0 && ox >= 0 && oy < oldN && ox < oldN) ? rows[oy][ox] : '.';
    }
    out.push(r);
  }
  return out;
}

console.log('== the reader stands alone ==');
console.log('  the reader needs nothing but itself:');
console.log('    ' + Object.keys(reader).join(', '));

console.log('\n== it reads what the generator writes ==');
for (const v of [4, 6, 8, 10]) {
  const pipe = P.PIPELINES.custom;
  const lay = pipe.layout(URL, v);
  const art = P.artFromRows(reframe(P.TEMPLATE_ROWS.CAT, lay.G));
  const w = pipe.fit(URL, v, art, { style: 'dots' });
  const img = P.renderDiscRGBA(w.t.modules, lay.G, lay, 1024, 'dots');
  // the reader alone, given the pixels
  const got = reader.readImage(img.data, img.width, img.height);
  check('v' + v + ' reads back', got && got.url === URL, String(got && got.url));
  check('v' + v + ' knows the version', got && got.version === v, 'v' + (got && got.version));
  check('v' + v + ' used the format block', got && got.format === true);
}

console.log('\n== and it reads a picture, not a matrix ==');
{
  const pipe = P.PIPELINES.custom;
  const lay = pipe.layout(URL, 6);
  const art = P.artFromRows(reframe(P.TEMPLATE_ROWS.CAT, lay.G));
  const w = pipe.fit(URL, 6, art, { style: 'dots' });
  const img = P.renderDiscRGBA(w.t.modules, lay.G, lay, 1024, 'dots');
  // a screenshot: flattened onto white, with a margin
  const M = 40, S = 1024 + M * 2;
  const flat = new Uint8ClampedArray(S * S * 4).fill(255);
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      const p = ((y + M) * S + (x + M)) * 4, q = (y * 1024 + x) * 4;
      flat[p] = img.data[q]; flat[p + 1] = img.data[q + 1]; flat[p + 2] = img.data[q + 2];
      flat[p + 3] = 255;
    }
  }
  const got = reader.readImage(flat, S, S);
  check('a screenshot reads back', got && got.url === URL, String(got && got.url));
}

console.log('\n== and it leaves the standard codes to jsQR ==');
{
  const n = 41;
  const art = P.artFromRows(reframe(P.TEMPLATE_ROWS.CAT, n));
  const w = P.fitWorkbench(URL, 6, art, { style: 'dots' });
  const std = P.renderRGBA(w.t.modules, n, 16, 4, 'dots');
  const without = reader.readImage(std.data, std.width, std.height);
  check('without a decoder it does not claim to read a standard QR',
    !without || without.kind !== 'standard', String(without && without.kind));
  const withDecoder = reader.readImage(std.data, std.width, std.height, require('../lib/jsQR.js'));
  check('handed a decoder, it reads one', withDecoder && withDecoder.kind === 'standard',
    String(withDecoder && withDecoder.url));
}

console.log('\n== done ==' + (failures ? '  ' + failures + ' FAILURES' : '  all checks passed'));
process.exit(failures ? 1 : 0);
