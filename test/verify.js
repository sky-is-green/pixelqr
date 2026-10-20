/**
 * Headless verification for PixelQR core (node).
 * Usage: node test/verify.js
 */
'use strict';

const PixelQR = require('../core.js');
const URL = 'https://USER.github.io';

function readBits(bytes, pos, len) {
  let v = 0;
  for (let i = 0; i < len; i++) {
    v = (v << 1) | ((bytes[(pos + i) >> 3] >> (7 - ((pos + i) & 7))) & 1);
  }
  return v;
}

console.log('== structural roundtrip: extract bits from rendered QR, re-parse URL ==');
const URL_BY_V = { 3: URL, 4: URL };
let allOk = true;
for (const v of [3, 4]) {
  const urlV = URL_BY_V[v];
  for (let m = 0; m < 8; m++) {
    const base = PixelQR.buildBase(urlV, v, m);
    const bits = PixelQR.extractPreMaskBits(base.modules, base.order, m, base.n);
    // codeword bytes (MSB first)
    const totalCw = base.plan.totalCw;
    const bytes = [];
    for (let c = 0; c < totalCw; c++) {
      let b = 0;
      for (let k = 0; k < 8; k++) b = (b << 1) | bits[c * 8 + k];
      bytes.push(b);
    }
    const plan = base.plan;
    const dataLen = plan.rsBlocks.reduce((s, b) => s + b.dataCount, 0);
    const blocks = PixelQR.deinterleaveData(bytes.slice(0, dataLen), plan);
    // message order = blocks concatenated (consecutive split, interleaved on the wire)
    const flat = [].concat(...blocks);
    const mode = readBits(flat, 0, 4);
    const len = readBits(flat, 4, 8);
    let text = '';
    for (let i = 0; i < len; i++) text += String.fromCharCode(readBits(flat, 12 + i * 8, 8));
    const ok = mode === 4 && text === urlV;
    allOk = allOk && ok;
    if (!ok) console.log(`  v${v} mask${m}: FAIL mode=${mode} len=${len} text="${text}"`);
  }
  console.log(`  v${v}: ${allOk ? 'all masks OK' : 'FAILURES ABOVE'}`);
}
console.log(allOk ? '  => walk/mask/function-mask/block mapping all correct' : '  => MAPPING BUG');

console.log('\n== CAT art: flips vs strength (mask 2) ==');
const art = PixelQR.artFromRows(PixelQR.TEMPLATE_ROWS.CAT);
for (const strength of [0.3, 0.5, 0.7, 0.9, 1.0]) {
  const base = PixelQR.buildBase(URL, 3, 2);
  const t = PixelQR.autoTune(base, art, { strength });
  const dec = (box, blur) => {
    const img = PixelQR.renderRGBA(t.modules, base.n, box, 4);
    return PixelQR.decodeRGBA(blur ? PixelQR.blurRGBA(img) : img) === URL;
  };
  console.log(`  strength ${strength.toFixed(1)}: flips=${String(t.flips).padStart(3)} cw=${t.cwUsed}/${t.cwBudget} verified=${t.verified} iters=${t.iterations}` +
    `  [296px:${dec(8) ? 'C' : '-'} 185px:${dec(5) ? 'C' : '-'} 148px+blur:${dec(4, true) ? 'B' : '-'} 111px+blur:${dec(3, true) ? 'B' : '-'}]`);
}
console.log('  (pyqart reference for same art: 182 flips, decodes)');

console.log('\n== templates × masks: autoTune (strength 0.9) ==');
console.table(PixelQR.selfTest(URL, { strength: 0.9 }));

console.log('\n== best-mask flow (as the app will use it) ==');
const bm = PixelQR.bestMask(URL, 3, art);
const base = PixelQR.buildBase(URL, 3, bm);
const tuned = PixelQR.autoTune(base, art, { strength: 0.9 });
console.log('  bestMask for CAT =', bm, '| flips:', tuned.flips, '| verified:', tuned.verified);

console.log('\n== high-version check (v4, longer URL) ==');
const URL2 = 'https://example-person.github.io';
const art4 = PixelQR.artFromRows(PixelQR.TEMPLATE_ROWS.CAT); // padded/wrong size → skip art for v4? use HEART scaled? just decode base
const plan4 = PixelQR.codePlan(4, 'H');
console.log('  v4 plan: blocks =', plan4.blockCount, 't/block =', plan4.tPerBlock.join(','), 'totalCw =', plan4.totalCw);
