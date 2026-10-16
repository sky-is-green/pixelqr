/**
 * PixelQR core — pixel art ⇄ scannable QR engine.
 *
 * The trick (QArt-style): error correction level H lets each RS block tolerate
 * t = floor(ec_codewords / 2) corrupted codewords and still decode. We "sacrifice"
 * whole codewords (all 8 modules of a codeword flipped together = 1 error) to
 * paint the artwork, spending a configurable share of that error budget.
 *
 * Key design (v2): the target is the WHOLE canvas, not just the ink.
 * Ink cells want dark, every other drawable cell wants light. That means the
 * budget is spent both *drawing* (light→dark in ink) and *erasing* (dark→light
 * in the background around it) — which is what creates the contrast that makes
 * the drawing readable. Without the erase half, ink sits on 50% random noise.
 *
 * The encoded pattern depends on payload + mask, so we also search over a few
 * harmless link-suffix variants (#0..#z are fragments; they don't change where
 * the link goes) and all 8 masks, and pick the encoding that best fits the art.
 *
 * Remainder bits (7 cells in v2-6) carry no data — free art cells.
 * Everything is verified with a real decoder (jsQR): clean render AND a
 * blurred/downscaled render (scanning at a distance).
 *
 * Browser: load lib/qrcode.js, lib/jsQR.js, then this file → window.PixelQR.
 * Node:    require('./core.js').
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./lib/qrcode.js'), require('./lib/jsQR.js'));
  } else {
    root.PixelQR = factory(root.qrcode, root.jsQR);
  }
})(typeof self !== 'undefined' ? self : this, function (qrcode, jsQR) {
  'use strict';

  var ECL = 'H'; // error correction level: the art budget
  var ECL_NUM = { L: 1, M: 0, Q: 3, H: 2 }; // lib-internal numeric levels

  // Remainder bits per version (spec) — free art cells.
  var REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7 };

  // 29x29 (version 3) presets. '#' = ink (dark), '.' = light.
  var TEMPLATE_ROWS = {
    CAT: [
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '..........#.......#..........',
      '.........###.....###.........',
      '........#.###...###.#........',
      '.......##.####.####.##.......',
      '.......#######.#######.......',
      '.............................',
      '........####.....####........',
      '.......#.####...####.#.......',
      '.......#.####...####.#.......',
      '.......######...######.......',
      '........####.....####........',
      '.............###.............',
      '..............#..............',
      '...........##.#.##...........',
      '............##.##............',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................'
    ],
    SMILEY: [
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '..............#..............',
      '...........#######...........',
      '..........#########..........',
      '.........#...###...#.........',
      '........##...###...##........',
      '........##...###...##........',
      '........#############........',
      '.......###############.......',
      '........##.........##........',
      '........##.........##........',
      '........##.........##........',
      '.........##.......##.........',
      '..........##.....##..........',
      '...........#######...........',
      '..............#..............',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................'
    ],
    HEART: [
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.........####...####.........',
      '........#####...#####........',
      '........######.######........',
      '.......###############.......',
      '.......###############.......',
      '.......###############.......',
      '........#############........',
      '........#############........',
      '.........###########.........',
      '..........#########..........',
      '...........#######...........',
      '............#####............',
      '.............###.............',
      '..............#..............',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................',
      '.............................'
    ]
  };

  // ------------------------------ geometry -----------------------------------

  var ALIGN_CENTER = { 2: 18, 3: 22, 4: 26, 5: 30, 6: 34 };

  /** 1 = locked structural cell (never painted), 0 = drawable. */
  function buildFunctionMask(version) {
    var n = version * 4 + 17;
    var mask = new Uint8Array(n * n);
    function lockRect(y0, x0, h, w) {
      for (var y = y0; y < y0 + h; y++) {
        for (var x = x0; x < x0 + w; x++) {
          if (x >= 0 && y >= 0 && x < n && y < n) mask[y * n + x] = 1;
        }
      }
    }
    lockRect(0, 0, 9, 9);         // top-left finder + separator + format strip
    lockRect(0, n - 8, 9, 8);     // top-right finder + separator + format strip
    lockRect(n - 8, 0, 8, 9);     // bottom-left finder + separator + format strip
    for (var i = 0; i < n; i++) { mask[6 * n + i] = 1; mask[i * n + 6] = 1; } // timing
    var c = ALIGN_CENTER[version];
    if (c !== undefined) lockRect(c - 2, c - 2, 5, 5); // alignment pattern
    return mask;
  }

  /** Standard QR mask predicates. */
  function maskAt(mask, y, x) {
    switch (mask) {
      case 0: return (y + x) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (y + x) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((y * x) % 2 + (y * x) % 3) === 0;
      case 6: return (((y * x) % 2 + (y * x) % 3) % 2) === 0;
      default: return (((y + x) % 2 + (y * x) % 3) % 2) === 0;
    }
  }

  /**
   * Data-placement walk (spec zigzag, mirrors the encoder):
   * column pairs right→left, skipping the timing column; rows alternate.
   */
  function placementOrder(func, n) {
    var order = [];
    var col = n - 1;
    var upward = true;
    while (col > 0) {
      if (col === 6) col -= 1;
      for (var k = 0; k < n; k++) {
        var y = upward ? (n - 1 - k) : k;
        for (var dx = 0; dx < 2; dx++) {
          var x = col - dx;
          var i = y * n + x;
          if (!func[i]) order.push(i);
        }
      }
      upward = !upward;
      col -= 2;
    }
    return order;
  }

  /** RS block plan: interleaved global codeword → block, error capacity t per block. */
  function codePlan(version, ecl) {
    var rsBlocks = qrcode.QRRSBlock.getRSBlocks(version, ECL_NUM[ecl || ECL]);
    var bc = rsBlocks.length;
    var maxDc = 0, maxEc = 0;
    for (var r = 0; r < bc; r++) {
      maxDc = Math.max(maxDc, rsBlocks[r].dataCount);
      maxEc = Math.max(maxEc, rsBlocks[r].totalCount - rsBlocks[r].dataCount);
    }
    var blockOf = [];
    for (var i = 0; i < maxDc; i++) {
      for (var r2 = 0; r2 < bc; r2++) if (i < rsBlocks[r2].dataCount) blockOf.push(r2);
    }
    for (var i2 = 0; i2 < maxEc; i2++) {
      for (var r3 = 0; r3 < bc; r3++) {
        if (i2 < (rsBlocks[r3].totalCount - rsBlocks[r3].dataCount)) blockOf.push(r3);
      }
    }
    var t = rsBlocks.map(function (b) { return Math.floor((b.totalCount - b.dataCount) / 2); });
    return {
      rsBlocks: rsBlocks, blockCount: bc, blockOf: blockOf,
      tPerBlock: t, totalCw: blockOf.length, maxDc: maxDc, maxEc: maxEc
    };
  }

  // ------------------------------- engine ------------------------------------

  /** Render the base QR: {n, version, mask, url, modules, func, drawable, order, plan, cwOf}.
   *  padBytes (optional) overrides the pad codewords after the terminator — bits
   *  decoders never read, so the engine can solve for them freely. */
  function buildBase(url, version, mask, padBytes) {
    var qr = qrcode(version, ECL);
    qr.addData(url);
    qr.make(typeof mask === 'number' ? mask : undefined, padBytes);
    var n = qr.getModuleCount();
    var v = (n - 17) / 4;
    var modules = new Uint8Array(n * n);
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) modules[y * n + x] = qr.isDark(y, x) ? 1 : 0;
    }
    var func = buildFunctionMask(v);
    var order = placementOrder(func, n);
    var plan = codePlan(v);
    // map cell -> global codeword index (or -1 for locked/remainder = free cells)
    var cwOf = new Int32Array(n * n).fill(-1);
    var cwBits = plan.totalCw * 8;
    for (var p = 0; p < order.length && p < cwBits; p++) cwOf[order[p]] = p >> 3;
    var drawable = 0;
    for (var i = 0; i < n * n; i++) if (!func[i]) drawable++;
    return {
      n: n, version: v, mask: mask, url: url, modules: modules, func: func,
      drawable: drawable, order: order, plan: plan, cwOf: cwOf,
      remainder: order.length - cwBits
    };
  }

  // --------------------------- payload freedom ---------------------------------
  // Pad codewords after the terminator are never read by decoders (ISO 18004:
  // "pad codewords shall have no significance"). They are free bits: the map
  // from a pad bit to the module matrix is XOR-linear (RS, interleaving, mask
  // placement are all GF(2)-linear), so we can solve for pad values that toggle
  // up to `padBits` chosen modules exactly — ZERO error budget spent and the
  // decoded payload stays byte-for-byte intact. (QArtText takes free bits from
  // padding and solves them with Gauss-Jordan; same trick, different engine.)

  function utf8Len(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    var bytes = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      bytes += c < 0x80 ? 1 : (c < 0x800 ? 2 : 3);
    }
    return bytes;
  }

  /** Free pad codewords left by this url at this version (byte mode, ECL H). */
  function padShape(url, version) {
    var plan = codePlan(version);
    var totalData = 0;
    for (var r = 0; r < plan.rsBlocks.length; r++) totalData += plan.rsBlocks[r].dataCount;
    var bytes = utf8Len(url);
    var usedCw = bytes + 2; // mode(4) + count(8) + bytes + terminator(4), byte-aligned
    return { totalData: totalData, byteLen: bytes, padCount: Math.max(0, totalData - usedCw) };
  }

  var _padCache = {}; // version|mask|byteLen -> influence sets (content-independent)

  /** Module-toggle bitmap of each pad bit (cached; depends only on shape+mask). */
  function padInfluences(url, version, mask) {
    var shape = padShape(url, version);
    if (shape.padCount <= 0) return null;
    var key = version + '|' + mask + '|' + shape.byteLen;
    if (_padCache[key]) return _padCache[key];
    var n = version * 4 + 17;
    var n2 = n * n;
    var words = (n2 + 31) >> 5;
    var zero = [];
    for (var z = 0; z < shape.padCount; z++) zero.push(0);
    var m0 = buildBase(url, version, mask, zero).modules;
    var influences = [];
    for (var b = 0; b < shape.padCount * 8; b++) {
      var pads = zero.slice();
      pads[b >> 3] = 1 << (b & 7);
      var mb = buildBase(url, version, mask, pads).modules;
      var bm = new Uint32Array(words);
      var any = false;
      for (var w = 0; w < words; w++) {
        var v = 0;
        for (var k = 0; k < 32; k++) {
          var i = (w << 5) + k;
          if (i < n2 && m0[i] !== mb[i]) v |= 1 << k;
        }
        bm[w] = v;
        if (v) any = true;
      }
      influences.push(any ? bm : null);
    }
    var entry = { padCount: shape.padCount, padBits: shape.padCount * 8, words: words, influences: influences };
    _padCache[key] = entry;
    return entry;
  }

  /**
   * Solve the pad bits so the module matrix matches the art target as closely
   * as possible — free of charge. Returns null when there is no freedom.
   * { base, padBytes, padBits, fixed, missed } — base re-encoded with the solved
   * pads (authoritative matrix straight from the encoder).
   */
  function padSolve(base, art, opts) {
    var shape = padShape(base.url, base.version);
    if (shape.padCount <= 0) return null;
    var free = padInfluences(base.url, base.version, base.mask);
    if (!free) return null;
    var n = base.n, n2 = n * n;
    var zero = [];
    for (var z = 0; z < shape.padCount; z++) zero.push(0);
    var m0 = buildBase(base.url, base.version, base.mask, zero).modules;
    var tw = targetWeight(art, opts);

    // Constraints: free cells where the zero-pad base disagrees with the target,
    // highest weight first (ink cells above plaza cells above the rim).
    var cons = [];
    for (var i = 0; i < n2; i++) {
      if (base.func[i]) continue;
      if (m0[i] === tw.target[i]) continue;
      cons.push(i);
    }
    if (!cons.length) return null;
    cons.sort(function (a, b) { return tw.weight[b] - tw.weight[a]; });

    // module -> influencing pad bits
    var modVars = new Array(n2);
    for (var b = 0; b < free.padBits; b++) {
      var bm = free.influences[b];
      if (!bm) continue;
      for (var w = 0; w < free.words; w++) {
        var vv = bm[w];
        for (var k = 0; k < 32 && vv; k++) {
          if (vv & (1 << k)) {
            vv &= ~(1 << k);
            var mi = (w << 5) + k;
            if (mi < n2) {
              if (!modVars[mi]) modVars[mi] = [];
              modVars[mi].push(b);
            }
          }
        }
      }
    }

    // Gauss-Jordan over GF(2): rows are constraints, columns are pad bits.
    var nv = free.padBits;
    var wv = (nv + 31) >> 5;
    var pivotRowOfCol = new Int32Array(nv).fill(-1);
    var pivotRows = [];
    var fixed = 0, missed = 0;
    for (var c = 0; c < cons.length; c++) {
      var mi2 = cons[c];
      var vars = modVars[mi2];
      if (!vars) { missed++; continue; }
      var rhs = (tw.target[mi2] ^ m0[mi2]) & 1;
      var row = new Uint32Array(wv + 1); // last word bit0 = rhs
      for (var q = 0; q < vars.length; q++) row[vars[q] >> 5] ^= 1 << (vars[q] & 31);
      if (rhs) row[wv] ^= 1;
      for (var pc = 0; pc < nv; pc++) {
        var pr = pivotRowOfCol[pc];
        if (pr >= 0 && ((row[pc >> 5] >> (pc & 31)) & 1)) {
          var prow = pivotRows[pr];
          for (var w2 = 0; w2 <= wv; w2++) row[w2] ^= prow[w2];
        }
      }
      var found = -1;
      for (var pc2 = 0; pc2 < nv && found < 0; pc2++) {
        if ((row[pc2 >> 5] >> (pc2 & 31)) & 1) found = pc2;
      }
      if (found < 0) {
        if (row[wv] & 1) missed++; else fixed++;
        continue;
      }
      pivotRowOfCol[found] = pivotRows.length;
      pivotRows.push(row);
      for (var q2 = 0; q2 < pivotRows.length - 1; q2++) {
        if ((pivotRows[q2][found >> 5] >> (found & 31)) & 1) {
          for (var w3 = 0; w3 <= wv; w3++) pivotRows[q2][w3] ^= row[w3];
        }
      }
      fixed++;
    }

    var s = new Uint8Array(nv);
    for (var c2 = 0; c2 < nv; c2++) {
      var p2 = pivotRowOfCol[c2];
      if (p2 >= 0) s[c2] = pivotRows[p2][wv] & 1;
    }
    var padBytes = [];
    for (var pb = 0; pb < shape.padCount; pb++) {
      var byteVal = 0;
      for (var bit = 0; bit < 8; bit++) byteVal |= s[pb * 8 + bit] << bit;
      padBytes.push(byteVal);
    }
    var solvedBase = buildBase(base.url, base.version, base.mask, padBytes);
    return { base: solvedBase, padBytes: padBytes, padBits: nv, fixed: fixed, missed: missed };
  }

  // --------------------------- writable canvas --------------------------------
  // Workbench model: the code's randomness is kept OUT of the design area.
  // The writable canvas is a squircle around the centre; inside it every cell
  // is pinned to the drawing (ink → dark, background → light), and the flip
  // budget is sized so ZERO random cells survive inside. Outside is the code
  // ring, where the QR keeps its natural random life (unique per link).
  // The canvas grows with the error budget (version) and with the free pad
  // bits (shorter urls leave more).

  var RING_W = 0.15; // background weight outside the canvas

  /** Squircle distance of cell (x, y) from the centre, in cell units. */
  function squircleDist(x, y, n) {
    var cx = (n - 1) / 2;
    var ax = Math.abs(x - cx), ay = Math.abs(y - cx);
    return Math.max(ax, ay) + 0.35 * Math.min(ax, ay);
  }

  function canvasCells(n, R) {
    var c = 0;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (squircleDist(x, y, n) <= R) c++;
      }
    }
    return c;
  }

  /** Widest row of cells spanned by the canvas (for labels). */
  function canvasWidth(n, R) {
    var cx = (n - 1) / 2;
    return Math.floor(cx + R) - Math.ceil(cx - R) + 1;
  }

  function canvasAt(n, R, base) {
    return {
      R: R, cells: canvasCells(n, R), width: canvasWidth(n, R), n: n,
      cwBudget: base ? base.cwBudget : 0, padBits: base ? base.padBits : 0
    };
  }

  /** Largest squircle radius whose cell count fits `budget` (0.25-cell steps). */
  function canvasRadiusFor(budget, n) {
    var cap = 1.35 * ((n - 1) / 2 - 7) - 0.05; // stays clear of the finders
    var R = 0, cells = 0;
    for (var r = 2; r <= cap; r += 0.25) {
      var c = canvasCells(n, r);
      if (c <= budget) { R = r; cells = c; } else break;
    }
    return { R: R, cells: cells };
  }

  /**
   * Canvas geometry for a url + version. Each sacrificed codeword pins ~7 of
   * its canvas cells (the planner picks the densest codewords first); each
   * free pad bit patches ~0.55 of a cell (its toggle set is scattered and can
   * overlap). The 0.88 aggression leaves the last stretch to the adaptive fit,
   * which shrinks rather than overrun.
   */
  function canvasShape(url, version, opts) {
    opts = opts || {};
    var aggression = opts.aggression !== undefined ? opts.aggression : 0.88;
    var plan = codePlan(version);
    var tSum = 0;
    for (var b = 0; b < plan.tPerBlock.length; b++) tSum += plan.tPerBlock[b];
    var padBits = 0;
    try { padBits = padShape(url, version).padCount * 8; } catch (e) { padBits = 0; }
    var budget = (tSum * 7 + padBits * 0.55) * aggression;
    var n = version * 4 + 17;
    var fit = canvasRadiusFor(budget, n);
    var shape = canvasAt(n, fit.R, null);
    shape.cwBudget = tSum;
    shape.padBits = padBits;
    return shape;
  }

  /** Residual mismatches inside the canvas for a final module matrix. */
  function canvasResidual(modules, base, art, opts) {
    var tw = targetWeight(art, opts);
    var n = base.n;
    var out = { bg: 0, ink: 0, cells: 0 };
    for (var i = 0; i < n * n; i++) {
      if (base.func[i]) continue;
      if (squircleDist(i % n, (i / n) | 0, n) > opts.canvasR) continue;
      out.cells++;
      if (modules[i] === tw.target[i]) continue;
      if (tw.target[i] === 1) out.ink++; else out.bg++;
    }
    return out;
  }

  /** Single fixed-mask fit (no suffix/mask search) + pad solve. */
  function manualFit(url, version, art, opts) {
    opts = opts || {};
    var mask = typeof opts.mask === 'number' ? opts.mask : 0;
    var base = buildBase(url, version, mask);
    var pad = padSolve(base, art, opts);
    if (pad && pad.fixed > 0) base = pad.base;
    var plan = planFlips(base, art, opts);
    return { url: url, suffix: opts.suffix || '', mask: mask, base: base, plan: plan, score: plan.score, pad: pad };
  }

  /**
   * The workbench pipeline: canvas sizing → encoding search (or reuse) → pad
   * solve → flip budget → decode verify — then check the promise: zero random
   * cells inside the canvas. Retry order keeps the canvas STABLE and as big as
   * possible: (1) the established/re-used encoding, (2) a full search,
   * (3) the runner-up encodings at the same radius, and only if everything
   * fails, (4) shrink one step and start over.
   * opts.reuse {mask, suffix} — fast path for painting (skip the search, keep
   * the established encoding). Returns { fit, t, canvas, residual, attempts }.
   */
  function fitWorkbench(url, version, art, opts) {
    opts = opts || {};
    var shape = canvasShape(url, version, opts);
    if (opts.canvasR !== undefined) shape = canvasAt(shape.n, opts.canvasR, shape);
    if (shape.R < 3) throw 'link too long for version ' + version;
    var manual = typeof opts.mask === 'number';
    var last = null;
    var tried = {};
    var doneSearch = manual; // manual masks never run the search
    var attempts = 0;

    function evaluate(fit) {
      var t = autoTune(fit.base, art, {
        strength: 1.0,
        margin: opts.margin !== undefined ? opts.margin : 1.0,
        plan: fit.plan, style: opts.style, canvasR: shape.R
      });
      var residual = canvasResidual(t.modules, fit.base, art, { canvasR: shape.R });
      attempts++;
      return { fit: fit, t: t, canvas: shape, residual: residual, attempts: attempts };
    }

    for (var round = 0; round < 4; round++) {
      var queue = [];
      if (round === 0) {
        if (manual) queue.push({ mask: opts.mask, suffix: '' });
        else if (opts.reuse && typeof opts.reuse.mask === 'number') {
          queue.push({ mask: opts.reuse.mask, suffix: opts.reuse.suffix || '' });
        }
      }
      if (!doneSearch) queue.push(null); // null = full search at this radius
      for (var qi = 0; qi < queue.length; qi++) {
        var ref = queue[qi];
        var o = {};
        for (var k in opts) o[k] = opts[k];
        o.canvasR = shape.R;
        var fit;
        if (ref) {
          tried[ref.mask + '|' + (ref.suffix || '')] = true;
          o.mask = ref.mask;
          o.suffix = ref.suffix || '';
          fit = manualFit(url + o.suffix, version, art, o);
        } else {
          fit = optimizeEncoding(url, version, art, o);
          doneSearch = true;
          var alts = fit.alt || [];
          for (var a = 0; a < alts.length && a < 6; a++) {
            var key = alts[a].mask + '|' + (alts[a].suffix || '');
            if (tried[key]) continue;
            tried[key] = true;
            queue.push(alts[a]);
          }
        }
        last = evaluate(fit);
        if (last.residual.bg === 0 && last.residual.ink === 0) return last;
      }
      // still stray cells: shrink one step and try again at the smaller radius
      var n2 = shape.n;
      var R2 = shape.R - 0.5;
      while (R2 > 3 && canvasCells(n2, R2) >= shape.cells) R2 -= 0.25;
      if (R2 <= 3) break;
      shape = canvasAt(n2, R2, shape);
      doneSearch = manual;
      tried = {};
    }
    return last;
  }

  /** Pre-mask bitstream (1 = dark before masking) in placement order. */
  function extractPreMaskBits(modules, order, mask, n) {
    var bits = new Uint8Array(order.length);
    for (var p = 0; p < order.length; p++) {
      var i = order[p];
      var y = (i / n) | 0, x = i % n;
      bits[p] = modules[i] ^ (maskAt(mask, y, x) ? 1 : 0);
    }
    return bits;
  }

  /** De-interleave the data section back into per-block byte arrays. */
  function deinterleaveData(bytes, plan) {
    var blocks = [];
    for (var r = 0; r < plan.blockCount; r++) blocks.push([]);
    var idx = 0;
    for (var i = 0; i < plan.maxDc; i++) {
      for (var r2 = 0; r2 < plan.blockCount; r2++) {
        if (i < plan.rsBlocks[r2].dataCount) blocks[r2].push(bytes[idx++]);
      }
    }
    return blocks;
  }

  /** '#' -> 1 (ink/dark), '.' -> 0 (light), '~'/other -> 2 (auto → light target, softer weight). */
  function artFromRows(rows) {
    var n = rows.length;
    var art = new Uint8Array(n * n);
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        var ch = rows[y][x];
        art[y * n + x] = ch === '#' ? 1 : (ch === '.' ? 0 : 2);
      }
    }
    return art;
  }

  /**
   * Target bitmap for the engine: ink → 1 (dark), everything else → 0 (light).
   * Weight: how strongly a cell should be respected.
   *  - ink cells weigh inkBoost × (0.45 + 0.55·spatial) — always above any
   *    background cell, so drawings are realized wherever they are;
   *  - background cells weigh `spatial`: 1.0 inside a rounded-square "plaza"
   *    around the center, fading to a floor of (1 − focus) at the rim. The
   *    middle gets cleaned, the outskirts keep their natural QR noise.
   */
  function targetWeight(art, opts) {
    opts = opts || {};
    var inkBoost = opts.inkBoost !== undefined ? opts.inkBoost : 3.0;
    var focus = opts.focus !== undefined ? opts.focus : 0.8;
    var n2 = art.length;
    var n = Math.round(Math.sqrt(n2));
    var floorS = Math.max(0.06, 1 - focus);
    var cx = (n - 1) / 2;
    var R1 = n * 0.33, R2 = n * 0.44; // plaza: flat 1.0 inside R1, fade to floor by R2
    var target = new Uint8Array(n2);
    var weight = new Float32Array(n2);
    if (opts.canvasR !== undefined) {
      // Workbench mode: strict writable canvas. Inside: pinned to the drawing
      // (ink dark, everything else light). Outside: the code ring — the QR's
      // own randomness, only lightly discouraged from spending budget.
      for (var c = 0; c < n2; c++) {
        var inside = squircleDist(c % n, (c / n) | 0, n) <= opts.canvasR;
        if (art[c] === 1) { target[c] = 1; weight[c] = inside ? inkBoost : 1.0; }
        else if (art[c] === 0) { target[c] = 0; weight[c] = inside ? 1.0 : RING_W; }
        else { target[c] = 0; weight[c] = inside ? 0.9 : RING_W * 0.85; }
      }
      return { target: target, weight: weight };
    }
    for (var i = 0; i < n2; i++) {
      var x = i % n, y = (i / n) | 0;
      var ax = Math.abs(x - cx), ay = Math.abs(y - cx);
      var dq = Math.max(ax, ay) + 0.35 * Math.min(ax, ay); // squircle distance, cells
      var spatial = dq <= R1 ? 1 : (dq >= R2 ? floorS : 1 - (1 - floorS) * (dq - R1) / (R2 - R1));
      if (art[i] === 1) { target[i] = 1; weight[i] = inkBoost * (0.45 + 0.55 * spatial); }
      else if (art[i] === 0) { target[i] = 0; weight[i] = spatial; }
      else { target[i] = 0; weight[i] = spatial * 0.85; } // auto: light, softer
    }
    return { target: target, weight: weight };
  }

  /** All cells where base disagrees with target, ranked by weight. */
  function rankConflicts(base, art, opts) {
    var tw = targetWeight(art, opts);
    var n = base.n, modules = base.modules, func = base.func;
    var out = [];
    for (var i = 0; i < n * n; i++) {
      if (func[i]) continue;
      if (modules[i] === tw.target[i]) continue;
      out.push({ i: i, want: tw.target[i], importance: tw.weight[i] });
    }
    out.sort(function (a, b) { return b.importance - a.importance; });
    return out;
  }

  /** The plan: which codewords to sacrifice, given art + budget opts. */
  function planFlips(base, art, opts) {
    opts = opts || {};
    var strength = opts.strength !== undefined ? opts.strength : 1.0;
    var margin = opts.margin !== undefined ? opts.margin : 1.0;
    var tw = targetWeight(art, opts);

    var byCw = {};
    var freeFlips = [];
    var totalConflictWeight = 0;
    var conflicts = 0;
    var n = base.n;
    for (var i = 0; i < n * n; i++) {
      if (base.func[i]) continue;
      if (base.modules[i] === tw.target[i]) continue;
      conflicts++;
      totalConflictWeight += tw.weight[i];
      var cw = base.cwOf[i];
      if (cw < 0) { freeFlips.push(i); continue; }
      if (!byCw[cw]) byCw[cw] = { benefit: 0, bits: [] };
      byCw[cw].benefit += tw.weight[i];
      byCw[cw].bits.push(i);
    }
    var cws = Object.keys(byCw).map(Number)
      .sort(function (a, b) { return byCw[b].benefit - byCw[a].benefit; });

    var capB = base.plan.tPerBlock.map(function (t) {
      return Math.max(0, Math.floor(t * margin * strength));
    });
    var used = new Array(base.plan.blockCount).fill(0);
    var selected = [];
    for (var k = 0; k < cws.length; k++) {
      var c = cws[k];
      var b = base.plan.blockOf[c];
      if (used[b] < capB[b]) { selected.push(c); used[b]++; }
    }

    // score = how many cells end up matching the target with this plan
    var matches = 0;
    for (var i2 = 0; i2 < n * n; i2++) {
      if (base.func[i2]) continue;
      if (base.modules[i2] === tw.target[i2]) matches += tw.weight[i2];
    }
    var fixed = 0;
    for (var f = 0; f < freeFlips.length; f++) fixed += tw.weight[freeFlips[f]];
    for (var s = 0; s < selected.length; s++) fixed += byCw[selected[s]].benefit;

    return {
      target: tw.target, weight: tw.weight,
      byCw: byCw, cws: cws, selected: selected, freeFlips: freeFlips,
      conflicts: conflicts, totalConflictWeight: totalConflictWeight,
      matches: matches, score: matches + fixed,
      capB: capB
    };
  }

  /** Apply a plan's flips. */
  function applyPlan(base, plan, keepSelected) {
    var keep = keepSelected || plan.selected;
    var modules = base.modules.slice();
    var flips = 0;
    var f;
    for (f = 0; f < plan.freeFlips.length; f++) { modules[plan.freeFlips[f]] ^= 1; flips++; }
    for (var k = 0; k < keep.length; k++) {
      var bits = plan.byCw[keep[k]].bits;
      for (var j = 0; j < bits.length; j++) { modules[bits[j]] ^= 1; flips++; }
    }
    return { modules: modules, flips: flips };
  }

  /**
   * Search over payload suffixes (harmless #-fragments) and all 8 masks for the
   * encoding whose base pattern best fits the art AFTER the flip budget.
   * Returns {url, suffix, mask, base, plan, score}.
   */
  function optimizeEncoding(url, version, art, opts) {
    opts = opts || {};
    var flipOpts = {
      strength: opts.strength !== undefined ? opts.strength : 1.0,
      margin: opts.margin !== undefined ? opts.margin : 1.0,
      inkBoost: opts.inkBoost,
      focus: opts.focus,
      canvasR: opts.canvasR
    };
    var suffixes = [''];
    if (url.indexOf('#') === -1) {
      suffixes.push('#'); // 1 extra byte: leaves a pad codeword AND a free fragment byte
      var alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
      for (var a = 0; a < alphabet.length; a++) suffixes.push('#' + alphabet[a]);
    }
    var candidates = [];
    for (var s = 0; s < suffixes.length; s++) {
      for (var m = 0; m < 8; m++) {
        var base;
        try {
          base = buildBase(url + suffixes[s], version, m);
        } catch (e) {
          continue; // suffix doesn't fit this version — skip
        }
        var plan = planFlips(base, art, flipOpts);
        candidates.push({ url: url + suffixes[s], suffix: suffixes[s], mask: m, base: base, plan: plan, score: plan.score });
      }
    }
    if (!candidates.length) {
      // fall back: base without suffix, mask 0
      var b0 = buildBase(url, version, 0);
      return { url: url, suffix: '', mask: 0, base: b0, plan: planFlips(b0, art, flipOpts), score: 0, pad: null };
    }
    candidates.sort(function (a, b) { return b.score - a.score; });
    var best = candidates[0];
    best.pad = null;
    if (opts.padding !== false) {
      // Padding is a second, FREE lever: re-solve the top candidates with pad
      // codewords chosen to fit the art, then re-plan the flip budget on the
      // solved base and keep the best final score. Distinct (mask|byteLen)
      // bases only — each costs one solve, and the influence sets are cached.
      var tried = {};
      var triedPerLen = {};
      var nTried = 0;
      for (var c = 0; c < candidates.length && nTried < 8; c++) {
        var cand = candidates[c];
        var lenKey = String(utf8Len(cand.url));
        var key = cand.mask + '|' + lenKey;
        if (tried[key]) continue;
        if ((triedPerLen[lenKey] || 0) >= 4) continue; // keep both payload lengths in play
        tried[key] = 1;
        triedPerLen[lenKey] = (triedPerLen[lenKey] || 0) + 1;
        nTried++;
        var solved = padSolve(cand.base, art, flipOpts);
        if (!solved || solved.fixed === 0) continue;
        var plan2 = planFlips(solved.base, art, flipOpts);
        if (plan2.score > best.score + 1e-9) {
          best = {
            url: cand.url, suffix: cand.suffix, mask: cand.mask,
            base: solved.base, plan: plan2, score: plan2.score, pad: solved
          };
        }
      }
    }
    // Runner-up encodings, for the workbench retry loop: if the winner leaves a
    // stray cell in the canvas, another mask/suffix often zeroes at the same size.
    best.alt = candidates.filter(function (c2) { return c2 !== best; }).slice(0, 8);
    return best;
  }

  // ------------------------------ rendering ----------------------------------

  /** RGBA pixel buffer of the QR (for decoding + display).
   *  style: 'square' (crisp modules, default) | 'rounded' (soft tiles) |
   *  'dots' (circles). Styled variants also redraw the three finders as
   *  rounded rings — the commercial "design QR" look — and are verified by
   *  decoding the styled raster itself. */
  function renderRGBA(modules, n, box, border, style) {
    style = style || 'square';
    var w = (n + 2 * border) * box;
    var data = new Uint8ClampedArray(w * w * 4);
    data.fill(255);
    if (style === 'square') {
      for (var y0 = 0; y0 < n; y0++) {
        for (var x0 = 0; x0 < n; x0++) {
          if (!modules[y0 * n + x0]) continue;
          for (var py0 = 0; py0 < box; py0++) {
            var row0 = ((y0 + border) * box + py0) * w;
            for (var px0 = 0; px0 < box; px0++) {
              var p0 = (row0 + (x0 + border) * box + px0) * 4;
              data[p0] = data[p0 + 1] = data[p0 + 2] = 0;
            }
          }
        }
      }
      return { data: data, width: w, height: w };
    }
    var SS = 3; // subsamples per axis (antialiasing)
    function sdRoundRect(u, v, half, rad) {
      var qx = Math.abs(u) - (half - rad);
      var qy = Math.abs(v) - (half - rad);
      var mx = Math.max(qx, 0), my = Math.max(qy, 0);
      return Math.sqrt(mx * mx + my * my) + Math.min(Math.max(qx, qy), 0) - rad;
    }
    /**
     * Shape functions per render style: { mod(u,v,x,y), eye(u,v) } — true when
     * a point (module units from the cell centre) is inside the shape. Module
     * shapes are tuned to touch their neighbours so dark runs stay connected
     * for the binarizer; every style is decode-tested in test/styles.js.
     */
    function styleShapes(st) {
      function inHex(u, v, R) { // R = circumradius (vertex distance)
        var a = R * 0.866;
        return Math.abs(v) <= a &&
               Math.abs(0.866 * u + 0.5 * v) <= a &&
               Math.abs(0.866 * u - 0.5 * v) <= a;
      }
      function inLeaf(u, v, h, r) { // two opposite corners deeply rounded
        if (Math.abs(u) > h || Math.abs(v) > h) return false;
        var q = h - r;
        if (u < -q && v < -q) return (u + q) * (u + q) + (v + q) * (v + q) <= r * r;
        if (u > q && v > q) return (u - q) * (u - q) + (v - q) * (v - q) <= r * r;
        return true;
      }
      var ringEye = function (u, v) {
        return (sdRoundRect(u, v, 3.5, 1.7) <= 0 && sdRoundRect(u, v, 2.5, 1.1) > 0) ||
               sdRoundRect(u, v, 1.5, 0.75) <= 0;
      };
      if (st === 'dots') {
        return {
          mod: function (u, v) { return u * u + v * v <= 0.5 * 0.5; }, // tangent circles
          eye: function (u, v) {
            var r = Math.sqrt(u * u + v * v);
            return (r <= 3.5 && r > 2.5) || r <= 1.5;
          }
        };
      }
      if (st === 'leaf') {
        // petals: two opposite corners rounded almost to the full half
        return {
          mod: function (u, v) { return inLeaf(u, v, 0.53, 0.48); },
          eye: function (u, v) {
            return (inLeaf(u, v, 3.5, 3.17) && !inLeaf(u, v, 2.5, 2.26)) || inLeaf(u, v, 1.5, 1.36);
          }
        };
      }
      if (st === 'hexagon') {
        // flat-top hexagons (0.55 vertex radius, cell-filling).
        // Eye ring: a hexagon stretched so its vertices AND its flats both sit
        // at the standard radii 3.5 / 2.5 (core 1.5) — so both the horizontal
        // and vertical finder scans read a perfect 1:1:3:1:1, and nothing
        // reaches past the 7×7 zone edge (no clipping).
        var hexEye = function (u, v, r) { return Math.abs(v) <= r && Math.abs(u) <= r - Math.abs(v) / 2; };
        return {
          mod: function (u, v) { return inHex(u, v, 0.55); },
          eye: function (u, v) { return (hexEye(u, v, 3.5) && !hexEye(u, v, 2.5)) || hexEye(u, v, 1.5); }
        };
      }
      if (st === 'plus' || st === 'clover') {
        var ae = 0.53, aw = 0.3, ar = st === 'clover' ? 0.24 : 0;
        var bar = function (u, v, wx, wy) {
          var qx = Math.abs(u) - (wx - ar), qy = Math.abs(v) - (wy - ar);
          var mx = Math.max(qx, 0), my = Math.max(qy, 0);
          return Math.sqrt(mx * mx + my * my) + Math.min(Math.max(qx, qy), 0) - ar;
        };
        return {
          // pixel-cross, or the rounded-arm "clover/petal" variant
          mod: function (u, v) {
            return bar(u, v, aw, ae) <= 0 || bar(u, v, ae, aw) <= 0;
          },
          eye: ringEye
        };
      }
      if (st === 'squircle') {
        return {
          mod: function (u, v) {
            var a = Math.abs(u / 0.55), b = Math.abs(v / 0.55);
            return a * a * a * a + b * b * b * b <= 1;
          },
          eye: ringEye
        };
      }
      if (st === 'triangle') {
        // up-pointing triangles, scaled up so they touch their neighbours
        var sc = 0.55 * 1.3;
        return {
          mod: function (u, v) { return v <= sc && v >= 2 * Math.abs(u) - sc; },
          eye: ringEye
        };
      }
      if (st === 'diamond') {
        var dia = function (u, v, r) { return Math.abs(u) + Math.abs(v) <= r; };
        return {
          mod: function (u, v) { return dia(u, v, 0.7); },
          // diamond eyes at the standard 3.5 / 2.5 / 1.5 radii → exactly the
          // square eye's run-lengths along both axes, vertices on the zone edge
          eye: function (u, v) { return (dia(u, v, 3.5) && !dia(u, v, 2.5)) || dia(u, v, 1.5); }
        };
      }
      // 'rounded' (and anything unknown)
      return {
        mod: function (u, v) { return sdRoundRect(u, v, 0.53, 0.32) <= 0; },
        eye: ringEye
      };
    }
    function paintZone(x0, y0, size, inside) {
      var px0 = (x0 + border) * box, py0 = (y0 + border) * box;
      var side = size * box;
      var cxm = x0 + size / 2, cym = y0 + size / 2;
      for (var py = py0; py < py0 + side; py++) {
        for (var px = px0; px < px0 + side; px++) {
          var cov = 0;
          for (var sy = 0; sy < SS; sy++) {
            for (var sx = 0; sx < SS; sx++) {
              var u = (px + (sx + 0.5) / SS) / box - border - cxm;
              var v = (py + (sy + 0.5) / SS) / box - border - cym;
              if (inside(u, v, x0, y0)) cov++;
            }
          }
          if (!cov) continue;
          var p = (py * w + px) * 4;
          var c = 255 - Math.round(255 * cov / (SS * SS));
          data[p] = data[p + 1] = data[p + 2] = c;
        }
      }
    }
    var shapes = styleShapes(style);
    var modInside = shapes.mod;
    var inFinder = function (x, y) {
      return (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
    };
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (!modules[y * n + x] || inFinder(x, y)) continue;
        paintZone(x, y, 1, modInside);
      }
    }
    var eyeInside = shapes.eye;
    var zones = [[0, 0], [n - 7, 0], [0, n - 7]];
    for (var f = 0; f < 3; f++) {
      var fx = zones[f][0], fy = zones[f][1];
      for (var py2 = (fy + border) * box; py2 < (fy + border + 7) * box; py2++) {
        for (var px2 = (fx + border) * box; px2 < (fx + border + 7) * box; px2++) {
          var p2 = (py2 * w + px2) * 4;
          data[p2] = data[p2 + 1] = data[p2 + 2] = 255;
        }
      }
      paintZone(fx, fy, 7, eyeInside);
    }
    return { data: data, width: w, height: w };
  }

  /** One 3x3 box-blur pass — simulates camera softness. */
  function blurRGBA(img) {
    var w = img.width, h = img.height, src = img.data;
    var out = new Uint8ClampedArray(src);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var acc = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            acc += src[((y + dy) * w + (x + dx)) * 4];
          }
        }
        acc = (acc / 9) | 0;
        var p = (y * w + x) * 4;
        out[p] = out[p + 1] = out[p + 2] = acc;
      }
    }
    return { data: out, width: w, height: h };
  }

  function decodeRGBA(img) {
    var res = jsQR(img.data, img.width, img.height);
    return res ? res.data : null;
  }

  function verify(modules, n, url, style) {
    var clean = decodeRGBA(renderRGBA(modules, n, 8, 4, style)) === url;
    var small = blurRGBA(renderRGBA(modules, n, 4, 4, style));
    var stressed = decodeRGBA(small) === url;
    return { clean: clean, stressed: stressed };
  }

  // ------------------------------- tuning ------------------------------------

  /**
   * Flip toward the art as much as the code can afford.
   * opts.strength 0..1 — share of each RS block's safe error capacity to spend
   * opts.margin   0..1 — safety factor on t (default 1.0; verified by decode)
   * opts.plan     — a precomputed planFlips() result (from optimizeEncoding)
   * Returns {modules, flips, cwUsed, cwBudget, inkRealized, ...} + verification.
   */
  function autoTune(base, art, opts) {
    opts = opts || {};
    var plan = opts.plan || planFlips(base, art, opts);
    var budgeted = plan.selected;

    var baseline = verify(base.modules, base.n, base.url, opts.style);
    if (!baseline.clean) {
      var baseRes0 = { clean: baseline.clean, stressed: baseline.stressed };
      return { modules: base.modules, flips: 0, cwUsed: 0, cwBudget: budgeted.length,
               conflicts: plan.conflicts, iterations: 0, verified: false,
               inkRealized: 0, clean: baseRes0.clean, stressed: baseRes0.stressed,
               note: 'baseline-fail', plan: plan };
    }
    var requireStressed = opts.requireStressed !== false && baseline.stressed;

    var keep = budgeted.slice();
    var result = null;
    for (var iter = 1; iter <= 12; iter++) {
      var applied = applyPlan(base, plan, keep);
      var res = verify(applied.modules, base.n, base.url, opts.style);
      result = { modules: applied.modules, flips: applied.flips, cwUsed: keep.length,
                 cwBudget: budgeted.length, conflicts: plan.conflicts, iterations: iter,
                 verified: false, clean: res.clean, stressed: res.stressed,
                 note: 'trimmed', plan: plan };
      if (res.clean && (res.stressed || !requireStressed)) {
        result.verified = true;
        result.note = 'ok';
        result.inkRealized = realizedInk(base, plan, keep, applied.modules);
        return result;
      }
      if (keep.length === 0) break;
      keep = keep.slice(0, Math.floor(keep.length * 0.75));
    }
    var baseRes = verify(base.modules, base.n, base.url, opts.style);
    return { modules: base.modules, flips: 0, cwUsed: 0, cwBudget: budgeted.length,
             conflicts: plan.conflicts, iterations: 12, verified: false,
             inkRealized: 0, clean: baseRes.clean, stressed: baseRes.stressed,
             note: 'reduced-to-zero', plan: plan };
  }

  /** Fraction of ink-cell mismatch that got resolved (for the UI). */
  function realizedInk(base, plan, keepSelected, finalModules) {
    var target = plan.target;
    var inkTotal = 0, inkOk = 0;
    for (var i = 0; i < base.n * base.n; i++) {
      if (base.func[i] || target[i] !== 1) continue;
      inkTotal++;
      if (finalModules[i] === 1) inkOk++;
    }
    return inkTotal ? inkOk / inkTotal : 1;
  }

  /** Art-match score of a base pattern (kept for compatibility). */
  function scoreMask(base, art) {
    var plan = planFlips(base, art, { strength: 1.0, margin: 1.0 });
    return plan.score;
  }

  function bestMask(url, version, art) {
    var best = null;
    for (var m = 0; m < 8; m++) {
      var base = buildBase(url, version, m);
      var score = scoreMask(base, art);
      if (!best || score > best.score) best = { mask: m, score: score };
    }
    return best.mask;
  }

  /** SVG export of a final module matrix (style-aware). */
  function toSVG(modules, n, box, border, style) {
    box = box || 12; border = border || 4;
    style = style || 'square';
    var size = (n + 2 * border) * box;
    var parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
                 '" viewBox="0 0 ' + size + ' ' + size + '"' +
                 (style === 'square' ? ' shape-rendering="crispEdges"' : '') + '>',
                 '<rect width="' + size + '" height="' + size + '" fill="#fff"/>'];
    var defs = [];
    var inFinder = function (x, y) {
      return (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
    };
    var leafPathD = function (cx, cy, h, r) {
      return 'M ' + (cx - h) + ' ' + (cy - h + r) +
             ' A ' + r + ' ' + r + ' 0 0 1 ' + (cx - h + r) + ' ' + (cy - h) +
             ' L ' + (cx + h) + ' ' + (cy - h) +
             ' L ' + (cx + h) + ' ' + (cy + h - r) +
             ' A ' + r + ' ' + r + ' 0 0 1 ' + (cx + h - r) + ' ' + (cy + h) +
             ' L ' + (cx - h) + ' ' + (cy + h) + ' Z';
    };
    var hexPoints = function (cx, cy, R) { // R = circumradius
      var pts = [];
      for (var k = 0; k < 6; k++) {
        var a = k * Math.PI / 3;
        pts.push((cx + R * Math.cos(a)).toFixed(2) + ',' + (cy + R * Math.sin(a)).toFixed(2));
      }
      return pts.join(' ');
    };
    var hexD = function (cx, cy, R) { // R = circumradius
      var d = '';
      for (var k = 0; k < 6; k++) {
        var a = k * Math.PI / 3;
        d += (k === 0 ? 'M ' : 'L ') + (cx + R * Math.cos(a)).toFixed(2) + ' ' +
             (cy + R * Math.sin(a)).toFixed(2) + ' ';
      }
      return d + 'Z';
    };
    var hexEyeD = function (cx, cy, r) { // stretched eye hexagon
      return 'M ' + (cx + r) + ' ' + cy + ' L ' + (cx + r / 2) + ' ' + (cy - r) +
             ' L ' + (cx - r / 2) + ' ' + (cy - r) + ' L ' + (cx - r) + ' ' + cy +
             ' L ' + (cx - r / 2) + ' ' + (cy + r) + ' L ' + (cx + r / 2) + ' ' + (cy + r) + ' Z';
    };
    var diaD = function (cx, cy, r) {
      return 'M ' + cx + ' ' + (cy - r) + ' L ' + (cx + r) + ' ' + cy + ' L ' + cx + ' ' + (cy + r) +
             ' L ' + (cx - r) + ' ' + cy + ' Z';
    };
    var moduleShape = function (x, y) {
      var cx = (x + border + 0.5) * box, cy = (y + border + 0.5) * box;
      if (style === 'dots') {
        return '<circle cx="' + cx + '" cy="' + cy + '" r="' + (0.5 * box) + '" fill="#000"/>';
      }
      if (style === 'hexagon') {
        return '<polygon points="' + hexPoints(cx, cy, 0.55 * box) + '" fill="#000"/>';
      }
      if (style === 'squircle') {
        var sr = 0.55 * box;
        var pts = [];
        for (var k2 = 0; k2 < 24; k2++) {
          var th = k2 / 24 * Math.PI * 2;
          var c2 = Math.cos(th), s2 = Math.sin(th);
          var rad = sr / Math.pow(Math.pow(Math.abs(c2), 4) + Math.pow(Math.abs(s2), 4), 0.25);
          pts.push((cx + rad * c2).toFixed(2) + ',' + (cy + rad * s2).toFixed(2));
        }
        return '<polygon points="' + pts.join(' ') + '" fill="#000"/>';
      }
      if (style === 'diamond') {
        return '<path d="' + diaD(cx, cy, 0.7 * box) + '" fill="#000"/>';
      }
      if (style === 'leaf') {
        return '<path d="' + leafPathD(cx, cy, 0.53 * box, 0.48 * box) + '" fill="#000"/>';
      }
      var o = 0.03 * box, s = box + 2 * o;
      return '<rect x="' + ((x + border) * box - o) + '" y="' + ((y + border) * box - o) +
             '" width="' + s + '" height="' + s + '" rx="' + (0.32 * box) + '" fill="#000"/>';
    };
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (!modules[y * n + x]) continue;
        if (style !== 'square' && inFinder(x, y)) continue;
        parts.push(moduleShape(x, y));
      }
    }
    if (style !== 'square') {
      var zones = [[0, 0], [n - 7, 0], [0, n - 7]];
      for (var f = 0; f < 3; f++) {
        var zx2 = (zones[f][0] + border) * box, zy2 = (zones[f][1] + border) * box;
        var cx2 = zx2 + 3.5 * box, cy2 = zy2 + 3.5 * box;
        // clip the eye to its 7x7 finder zone — same as the raster engine, so
        // ring vertices can never pollute the separator
        defs.push('<clipPath id="eyec' + f + '"><rect x="' + zx2 + '" y="' + zy2 +
                  '" width="' + (7 * box) + '" height="' + (7 * box) + '"/></clipPath>');
        parts.push('<g clip-path="url(#eyec' + f + ')">');
        if (style === 'dots') {
          parts.push('<circle cx="' + cx2 + '" cy="' + cy2 + '" r="' + (3 * box) +
                     '" fill="none" stroke="#000" stroke-width="' + box + '"/>');
          parts.push('<circle cx="' + cx2 + '" cy="' + cy2 + '" r="' + (1.5 * box) + '" fill="#000"/>');
        } else if (style === 'hexagon') {
          parts.push('<path d="' + hexEyeD(cx2, cy2, 3.5 * box) + ' ' + hexEyeD(cx2, cy2, 2.5 * box) +
                     '" fill="#000" fill-rule="evenodd"/>');
          parts.push('<path d="' + hexEyeD(cx2, cy2, 1.5 * box) + '" fill="#000"/>');
        } else if (style === 'diamond') {
          parts.push('<path d="' + diaD(cx2, cy2, 3.5 * box) + ' ' + diaD(cx2, cy2, 2.5 * box) +
                     '" fill="#000" fill-rule="evenodd"/>');
          parts.push('<path d="' + diaD(cx2, cy2, 1.5 * box) + '" fill="#000"/>');
        } else if (style === 'leaf') {
          parts.push('<path d="' + leafPathD(cx2, cy2, 3 * box, 2.72 * box) +
                     '" fill="none" stroke="#000" stroke-width="' + box + '"/>');
          parts.push('<path d="' + leafPathD(cx2, cy2, 1.5 * box, 1.36 * box) +
                     '" fill="#000"/>');
        } else {
          parts.push('<rect x="' + (cx2 - 3 * box) + '" y="' + (cy2 - 3 * box) + '" width="' + (6 * box) +
                     '" height="' + (6 * box) + '" rx="' + (1.7 * box) + '" fill="none" stroke="#000" stroke-width="' + box + '"/>');
          parts.push('<rect x="' + (cx2 - 1.5 * box) + '" y="' + (cy2 - 1.5 * box) + '" width="' + (3 * box) +
                     '" height="' + (3 * box) + '" rx="' + (0.75 * box) + '" fill="#000"/>');
        }
        parts.push('</g>');
      }
    }
    if (defs.length) parts.splice(2, 0, '<defs>' + defs.join('') + '</defs>');
    parts.push('</svg>');
    return parts.join('');
  }

  function selfTest(url, opts) {
    url = url || 'https://USER.github.io';
    opts = opts || {};
    var names = opts.templates || Object.keys(TEMPLATE_ROWS);
    var report = [];
    names.forEach(function (name) {
      var art = artFromRows(TEMPLATE_ROWS[name]);
      [0, 2, 6].forEach(function (m) {
        var base = buildBase(url, 3, m);
        var t = autoTune(base, art, { strength: opts.strength || 1.0 });
        report.push({
          name: name, mask: m, flips: t.flips, cwUsed: t.cwUsed, cwBudget: t.cwBudget,
          conflicts: t.conflicts, inkRealized: t.inkRealized,
          verified: t.verified, clean: t.clean, stressed: t.stressed,
          note: t.note, iterations: t.iterations
        });
      });
    });
    return report;
  }

  return {
    ECL: ECL,
    REMAINDER_BITS: REMAINDER_BITS,
    TEMPLATE_ROWS: TEMPLATE_ROWS,
    buildFunctionMask: buildFunctionMask,
    maskAt: maskAt,
    placementOrder: placementOrder,
    codePlan: codePlan,
    buildBase: buildBase,
    extractPreMaskBits: extractPreMaskBits,
    deinterleaveData: deinterleaveData,
    artFromRows: artFromRows,
    targetWeight: targetWeight,
    rankConflicts: rankConflicts,
    utf8Len: utf8Len,
    padShape: padShape,
    padInfluences: padInfluences,
    padSolve: padSolve,
    canvasShape: canvasShape,
    canvasResidual: canvasResidual,
    fitWorkbench: fitWorkbench,
    manualFit: manualFit,
    squircleDist: squircleDist,
    canvasWidth: canvasWidth,
    planFlips: planFlips,
    applyPlan: applyPlan,
    optimizeEncoding: optimizeEncoding,
    renderRGBA: renderRGBA,
    blurRGBA: blurRGBA,
    decodeRGBA: decodeRGBA,
    verify: verify,
    autoTune: autoTune,
    realizedInk: realizedInk,
    scoreMask: scoreMask,
    bestMask: bestMask,
    toSVG: toSVG,
    selfTest: selfTest
  };
});
