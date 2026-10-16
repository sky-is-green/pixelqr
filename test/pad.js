/**
 * Payload-freedom (pad solve) + styled-render checks — node.
 * Usage: node test/pad.js
 *
 * The pad codewords after the terminator are never read by decoders, and the
 * pad-bit -> module map is XOR-linear. So we can solve for pad values that
 * toggle chosen modules exactly, for free (no error budget). This script
 * proves the linearity, the write-through, and the decode safety, then
 * measures the art quality with and without padding, plus the three render
 * styles (square/rounded/dots) against the real decoder.
 */
'use strict';
const fs = require('fs');
const P = require('./../core.js');
const URL = 'https://USER.github.io';
const N3 = 29, N4 = 33;

let failures = 0;
function check(name, cond, info) {
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + ' ' + name + (info !== undefined ? '  [' + info + ']' : ''));
  if (!cond) failures++;
}
function blank(n) { return Array.from({ length: n }, () => '.'.repeat(n)); }
function metrics(art, t, base, n) {
  let inkT = 0, inkOn = 0, bgT = 0, bgOn = 0;
  let plazaT = 0, plazaOn = 0, rimT = 0, rimOn = 0;
  const cx = (n - 1) / 2, R1 = n * 0.33, R2 = n * 0.44;
  for (let i = 0; i < n * n; i++) {
    if (base.func[i]) continue;
    const x = i % n, y = (i / n) | 0;
    const dq = Math.max(Math.abs(x - cx), Math.abs(y - cx)) + 0.35 * Math.min(Math.abs(x - cx), Math.abs(y - cx));
    const dark = t.modules[i] ? 1 : 0;
    if (art[i] === 1) { inkT++; inkOn += dark; }
    else { bgT++; bgOn += dark; if (dq <= R1) { plazaT++; plazaOn += dark; } else if (dq >= R2) { rimT++; rimOn += dark; } }
  }
  return {
    inkPct: inkT ? (100 * inkOn / inkT).toFixed(0) + '%' : '-',
    bgPct: bgT ? (100 * bgOn / bgT).toFixed(0) + '%' : '-',
    plazaPct: plazaT ? (100 * plazaOn / plazaT).toFixed(0) + '%' : '-',
    rimPct: rimT ? (100 * rimOn / rimT).toFixed(0) + '%' : '-'
  };
}
function run(url, version, rows, opts) {
  const n = version * 4 + 17;
  const art = P.artFromRows(rows);
  const t0 = Date.now();
  const fit = P.optimizeEncoding(url, version, art, opts);
  const fitMs = Date.now() - t0;
  const t = P.autoTune(fit.base, art, { strength: 1.0, margin: 1.0, plan: fit.plan, style: opts && opts.style });
  return { fit, t, art, fitMs, n, base: fit.base };
}

console.log('== 1. pad shape ==');
const s3 = P.padShape(URL, 3);
const s4 = P.padShape(URL, 4);
console.log('  v3: totalData=' + s3.totalData + ' used=' + (s3.byteLen + 2) + ' free=' + s3.padCount + ' cw (' + (s3.padCount * 8) + ' bits)');
console.log('  v4: totalData=' + s4.totalData + ' used=' + (s4.byteLen + 2) + ' free=' + s4.padCount + ' cw (' + (s4.padCount * 8) + ' bits)');
check('v3 leaves 2 pad codewords (16 free bits)', s3.padCount === 2, s3.padCount);
check('v4 leaves 12 pad codewords (96 free bits)', s4.padCount === 12, s4.padCount);

console.log('\n== 2. pad write-through + decode safety ==');
const pads3 = [0xa5, 0x5a];
const b3 = P.buildBase(URL, 3, 0, pads3);
{
  const bits = P.extractPreMaskBits(b3.modules, b3.order, b3.mask, N3);
  const bytes = [];
  for (let c = 0; c < b3.plan.totalCw; c++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[c * 8 + k];
    bytes.push(v);
  }
  const dataLen = b3.plan.rsBlocks.reduce((s, x) => s + x.dataCount, 0);
  const flat = [].concat(...P.deinterleaveData(bytes.slice(0, dataLen), b3.plan));
  const got = [flat[dataLen - 2], flat[dataLen - 1]];
  check('pad codewords land verbatim in the stream', got[0] === 0xa5 && got[1] === 0x5a, got.map(x => x.toString(16)).join(','));
  check('padded base still decodes to the url', P.decodeRGBA(P.renderRGBA(b3.modules, N3, 8, 4)) === URL);
}

console.log('\n== 3. linearity: encode(pads) == m0 XOR influences ==');
for (const v of [3, 4]) {
  const n = v * 4 + 17;
  const shape = P.padShape(URL, v);
  const free = P.padInfluences(URL, v, 2);
  const zero = new Array(shape.padCount).fill(0);
  const m0 = P.buildBase(URL, v, 2, zero).modules;
  const rnd = zero.map(() => (Math.random() * 256) | 0);
  const mr = P.buildBase(URL, v, 2, rnd).modules;
  const pred = m0.slice();
  for (let b = 0; b < shape.padCount * 8; b++) {
    if ((rnd[b >> 3] >> (b & 7)) & 1) {
      const bm = free.influences[b];
      if (!bm) continue;
      for (let w = 0; w < free.words; w++) {
        for (let k = 0; k < 32; k++) {
          if ((bm[w] >> k) & 1) pred[(w << 5) + k] ^= 1;
        }
      }
    }
  }
  let same = true, diff = 0;
  for (let i = 0; i < n * n; i++) if (pred[i] !== mr[i]) { same = false; diff++; }
  check('v' + v + ' linear map exact', same, same ? '' : diff + ' module mismatches');
}

console.log('\n== 4. art quality with vs without padding (v3) ==');
const catRows = P.TEMPLATE_ROWS.CAT;
const bareRows = blank(N3);
for (const [name, rows] of [['bare', bareRows], ['cat', catRows]]) {
  const fitP = run(URL, 3, rows, {});
  const fitN = run(URL, 3, rows, { padding: false });
  const mp = metrics(fitP.art, fitP.t, fitP.base, N3), mn = metrics(fitN.art, fitN.t, fitN.base, N3);
  console.log('  ' + name + ':');
  console.log('    no-pad : suffix=' + (fitN.fit.suffix || '-') + ' mask=' + fitN.fit.mask +
    ' conflicts=' + fitN.fit.plan.conflicts + ' flips=' + fitN.t.flips +
    ' ink=' + mn.inkPct + ' plaza=' + mn.plazaPct + ' rim=' + mn.rimPct + ' verified=' + fitN.t.verified);
  console.log('    +pad   : suffix=' + (fitP.fit.suffix || '-') + ' mask=' + fitP.fit.mask +
    ' conflicts=' + fitP.fit.plan.conflicts + ' flips=' + fitP.t.flips +
    ' ink=' + mp.inkPct + ' plaza=' + mp.plazaPct + ' rim=' + mp.rimPct + ' verified=' + fitP.t.verified +
    (fitP.fit.pad ? (' padFixed=' + fitP.fit.pad.fixed + '/' + fitP.fit.pad.padBits) : ' (no pad)'));
  check(name + ' padded decode verified', fitP.t.verified === true);
  check(name + ' padded score >= unpadded', fitP.fit.score >= fitN.fit.score - 1e-9);
  if (fitP.fit.pad) check(name + ' pad fixed > 0', fitP.fit.pad.fixed > 0, fitP.fit.pad.fixed);
}

console.log('\n== 5. v4 (more free bits = 96) ==');
{
  const rows4 = blank(N4);
  const fit = run(URL, 4, rows4, {});
  const m = metrics(fit.art, fit.t, fit.base, N4);
  console.log('  v4 bare: suffix=' + (fit.fit.suffix || '-') + ' mask=' + fit.fit.mask +
    ' conflicts=' + fit.fit.plan.conflicts + ' flips=' + fit.t.flips + ' plaza=' + m.plazaPct +
    ' rim=' + m.rimPct + ' verified=' + fit.t.verified +
    (fit.fit.pad ? (' padFixed=' + fit.fit.pad.fixed + '/' + fit.fit.pad.padBits) : ' (no pad)'));
  check('v4 padded decode verified', fit.t.verified === true);
}

console.log('\n== 6. styles x decoder (cat + bare, v3/v4) ==');
{
  const fitCat = run(URL, 3, catRows, { style: 'rounded' });
  const fitBare = run(URL, 3, bareRows, { style: 'rounded' });
  for (const [name, f] of [['cat', fitCat], ['bare', fitBare]]) {
    const url = f.fit.url;
    for (const style of ['square', 'rounded', 'dots']) {
      const clean = P.decodeRGBA(P.renderRGBA(f.t.modules, N3, 8, 4, style)) === url;
      const stressed = P.decodeRGBA(P.blurRGBA(P.renderRGBA(f.t.modules, N3, 4, 4, style))) === url;
      const tiny = P.decodeRGBA(P.blurRGBA(P.renderRGBA(f.t.modules, N3, 3, 4, style))) === url;
      console.log('  ' + name + ' ' + style.padEnd(8) + ' 296px:' + (clean ? 'C' : '-') + '  148px+blur:' + (stressed ? 'B' : '-') + '  111px+blur:' + (tiny ? 'b' : '-'));
      check(name + ' ' + style + ' decodes clean', clean);
    }
    // verify() itself with style (what autoTune does)
    const vres = P.verify(f.t.modules, N3, url, 'rounded');
    check(name + ' verify(style=rounded)', vres.clean === true && vres.stressed === true);
  }
}

console.log('\n== 7. dump raw renders for the sheet ==');
function dump(name, modules, n, box, style) {
  const img = P.renderRGBA(modules, n, box, 4, style);
  fs.writeFileSync('/tmp/opencode/pad_' + name + '.raw', Buffer.from(img.data.buffer));
  fs.writeFileSync('/tmp/opencode/pad_' + name + '.meta', JSON.stringify({ w: img.width }));
}
{
  const fitBare = run(URL, 3, bareRows, {});
  const fitCat = run(URL, 3, catRows, {});
  for (const style of ['square', 'rounded', 'dots']) {
    dump('bare_' + style, fitBare.t.modules, N3, 16, style);
    dump('cat_' + style, fitCat.t.modules, N3, 16, style);
  }
  console.log('  wrote /tmp/opencode/pad_*.raw (bare+cat x square/rounded/dots)');

  console.log('\n  cat result (padded):');
  for (let y = 0; y < N3; y++) {
    let s = '';
    for (let x = 0; x < N3; x++) s += fitCat.t.modules[y * N3 + x] ? '\u2588' : ' ';
    console.log('  ' + s);
  }
}

console.log('\n== done ==' + (failures ? '  ' + failures + ' FAILURES' : '  all checks passed'));
process.exit(failures ? 1 : 0);
