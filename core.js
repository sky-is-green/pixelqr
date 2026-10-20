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

  // Versions the engine supports. v7+ brings the multi-alignment-pattern
  // layout and the 18-bit version-information blocks; from v7 the error
  // budget roughly doubles per step, so the writable surface grows a lot.
  // v2 is out: at level H it carries so little that neither generation has
  // room to draw in it.
  var MIN_VERSION = 3;
  var MAX_VERSION = 13;

  // Alignment-pattern centre rows/cols per version (ISO/IEC 18004 table).
  // The three combinations that would collide with a finder are skipped.
  var ALIGN_POS = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
    14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74],
    17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86],
    20: [6, 34, 62, 90], 21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98],
    23: [6, 30, 54, 78, 102], 24: [6, 28, 54, 80, 106], 25: [6, 32, 58, 84, 110],
    26: [6, 30, 58, 86, 114], 27: [6, 34, 62, 90, 118], 28: [6, 26, 50, 74, 98, 122],
    29: [6, 30, 54, 78, 102, 126], 30: [6, 26, 52, 78, 104, 130],
    31: [6, 30, 56, 82, 108, 134], 32: [6, 34, 60, 86, 112, 138],
    33: [6, 30, 58, 86, 114, 142], 34: [6, 34, 62, 90, 118, 146],
    35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154],
    37: [6, 28, 54, 80, 106, 132, 158], 38: [6, 32, 58, 84, 110, 136, 162],
    39: [6, 26, 54, 82, 110, 138, 166], 40: [6, 30, 58, 86, 114, 142, 170]
  };

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
    // Alignment patterns (v2+): one 5x5 block per centre pair, except the
    // three that would sit inside a finder pattern.
    var pos = ALIGN_POS[version] || [];
    for (var a = 0; a < pos.length; a++) {
      for (var b = 0; b < pos.length; b++) {
        var row = pos[a], col = pos[b];
        if (row <= 7 && col <= 7) continue;              // top-left finder
        if (row <= 7 && col >= n - 8) continue;          // top-right finder
        if (row >= n - 8 && col <= 7) continue;          // bottom-left finder
        lockRect(row - 2, col - 2, 5, 5);
      }
    }
    // Version information (v7+): two 6x3 blocks, top-right and bottom-left.
    if (version >= 7) {
      lockRect(0, n - 11, 6, 3);
      lockRect(n - 11, 0, 3, 6);
    }
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

  /**
   * The alignment patterns of a version: the top-left corners of their 5×5
   * blocks, minus the three that would sit inside a finder pattern. From v7
   * on there is one exactly in the middle of the code — in the middle of the
   * drawing area — and the code needs it, so it cannot be painted on.
   */
  function alignmentPatterns(version) {
    var n = version * 4 + 17;
    var pos = ALIGN_POS[version] || [];
    var out = [];
    for (var a = 0; a < pos.length; a++) {
      for (var b = 0; b < pos.length; b++) {
        var row = pos[a], col = pos[b];
        if (row <= 7 && col <= 7) continue;              // top-left finder
        if (row <= 7 && col >= n - 8) continue;          // top-right finder
        if (row >= n - 8 && col <= 7) continue;          // bottom-left finder
        out.push({ x: col - 2, y: row - 2 });
      }
    }
    return out;
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
    // Byte mode: 4-bit mode + character-count indicator + data + terminator.
    // The count indicator is 8 bits up to v9 and 16 bits from v10 on, so the
    // first pad codeword lands one codeword later on the bigger versions.
    var countBits = version <= 9 ? 8 : 16;
    var bits = 4 + countBits + bytes * 8;
    if (bits + 4 <= totalData * 8) bits += 4; // terminator (only if it fits)
    var usedCw = Math.ceil(bits / 8);
    return { totalData: totalData, byteLen: bytes, padCount: Math.max(0, totalData - usedCw) };
  }

  var _padCache = {}; // version|mask|byteLen|pipeline -> influence sets (content-independent)

  /** Module-toggle bitmap of each pad bit (cached; depends only on shape+mask). */
  function padInfluences(url, version, mask, opts) {
    opts = opts || {};
    var shape = padShape(url, version);
    if (shape.padCount <= 0) return null;
    var build = opts.build || buildBase;
    var key = (opts.cacheKey || 'std') + '|' + version + '|' + mask + '|' + shape.byteLen;
    if (_padCache[key]) return _padCache[key];
    var n = version * 4 + 17;
    var n2 = n * n;
    var words = (n2 + 31) >> 5;
    var zero = [];
    for (var z = 0; z < shape.padCount; z++) zero.push(0);
    var m0 = build(url, version, mask, zero).modules;
    var influences = [];
    for (var b = 0; b < shape.padCount * 8; b++) {
      var pads = zero.slice();
      pads[b >> 3] = 1 << (b & 7);
      var mb = build(url, version, mask, pads).modules;
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
    opts = opts || {};
    var build = opts.build || buildBase;
    var shape = padShape(base.url, base.version);
    if (shape.padCount <= 0) return null;
    var free = padInfluences(base.url, base.version, base.mask, opts);
    if (!free) return null;
    var n = base.n, n2 = n * n;
    var zero = [];
    for (var z = 0; z < shape.padCount; z++) zero.push(0);
    var m0 = build(base.url, base.version, base.mask, zero).modules;
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
    var solvedBase = build(base.url, base.version, base.mask, padBytes);
    return { base: solvedBase, padBytes: padBytes, padBits: nv, fixed: fixed, missed: missed };
  }

  // ------------------------------- surfaces ----------------------------------
  // Workbench model: the code's randomness is kept OUT of the design area.
  // The "surface" is the region the user may paint and the region the engine
  // guarantees to be free of random code cells. It has a shape (squircle,
  // circle, cross) and a radius; the radius comes from the error budget, the
  // shape is the user's choice. Outside the surface is the code ring, where the
  // QR keeps its natural random life (unique per link).
  // The surface grows with the error budget (version) and with the free pad
  // bits (shorter urls leave more).

  var RING_W = 0.1; // background weight outside the surface

  var SURFACE_KINDS = ['squircle', 'circle', 'cross'];

  var SURFACE_LABELS = {
    squircle: 'rounded square',
    circle: 'circle',
    cross: 'cross'
  };

  /** Squircle distance of cell (x, y) from the centre, in cell units. */
  function squircleDist(x, y, n) {
    var cx = (n - 1) / 2;
    var ax = Math.abs(x - cx), ay = Math.abs(y - cx);
    return Math.max(ax, ay) + 0.35 * Math.min(ax, ay);
  }

  /** Is cell (x, y) inside the surface of this shape and radius? */
  function surfaceHas(kind, R, x, y, n) {
    var cx = (n - 1) / 2;
    var ax = Math.abs(x - cx), ay = Math.abs(y - cx);
    if (kind === 'circle') return ax * ax + ay * ay <= R * R;
    if (kind === 'cross') return ax <= R || ay <= R;
    return squircleDist(x, y, n) <= R;
  }

  /**
   * Cells inside the surface. This is the budget metric: the planner spends
   * error budget on whole codewords, and a codeword that straddles the surface
   * edge still costs a full error, so the count includes the locked cells the
   * surface covers (the timing line, the alignment pattern, the format
   * strips) — that is what the per-codeword estimate was calibrated against.
   */
  function surfaceCells(kind, R, n) {
    var c = 0;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (surfaceHas(kind, R, x, y, n)) c++;
      }
    }
    return c;
  }

  /** The cells inside the surface that can actually be painted. */
  function surfaceDrawable(kind, R, n, func) {
    var c = 0;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (func && func[y * n + x]) continue;
        if (surfaceHas(kind, R, x, y, n)) c++;
      }
    }
    return c;
  }

  /** Largest radius the surface may take: the grid, and the finders' clearance. */
  function surfaceCap(kind, n) {
    var cx = (n - 1) / 2;
    if (kind === 'circle') return Math.min(cx, Math.SQRT2 * (cx - 7)) - 0.05;
    if (kind === 'cross') return cx - 7.5;
    return 1.35 * (cx - 7) - 0.05; // the squircle's diagonal must clear the finders
  }

  /** Widest row of cells spanned by the surface (for labels). */
  function surfaceWidth(kind, R, n) {
    var cx = (n - 1) / 2;
    if (kind === 'cross') return n; // the arms run to the code's edges
    return Math.floor(cx + R) - Math.ceil(cx - R) + 1;
  }

  /** The surface descriptor everything else works against. */
  var SURFACE_CORE = { kind: 1, R: 1, n: 1, cells: 1, drawable: 1, width: 1 };
  function surfaceAt(kind, R, n, extra) {
    var func = extra && extra.func;
    var s = {
      kind: kind, R: R, n: n,
      cells: surfaceCells(kind, R, n),
      drawable: surfaceDrawable(kind, R, n, func),
      width: surfaceWidth(kind, R, n)
    };
    if (extra) {
      for (var k in extra) {
        if (k !== 'func' && !SURFACE_CORE[k]) s[k] = extra[k];
      }
    }
    return s;
  }

  /** Largest radius whose cell count fits `budget` (0.25-cell steps). */
  function surfaceRadiusFor(kind, budget, n) {
    var cap = surfaceCap(kind, n);
    var R = 0, cells = 0;
    // The cell count is a step function of the radius (a shape only changes
    // when a cell crosses the boundary), so scan the whole range and keep the
    // largest radius that still fits.
    for (var r = 2; r <= cap; r += 0.25) {
      var c = surfaceCells(kind, r, n);
      if (c <= budget) { R = r; cells = c; }
    }
    return { R: R, cells: cells };
  }

  /**
   * How many codewords a surface touches. A codeword is eight modules (four
   * rows by two columns), so a blob of C cells needs about C/8 of them, plus
   * the ones that straddle the edge — roughly 1.3 per cell of radius.
   */
  function surfaceCodewords(cells, R) {
    return cells / 8 + 1.3 * R;
  }

  /**
   * Does a surface fit inside the error budget? The budget is per RS block: a
   * block can absorb t sacrificed codewords. The codewords a surface touches
   * are not spread evenly over the blocks — the placement walk hands them out
   * in runs, and the runs start on different blocks — so the tightest block
   * decides, not the average.
   */
  function surfaceFitsBlocks(base, kind, R, factor) {
    var n = base.n, plan = base.plan;
    var counts = new Int32Array(plan.blockCount);
    var seen = new Uint8Array(plan.totalCw);
    for (var i = 0; i < n * n; i++) {
      if (base.func[i]) continue;
      if (!surfaceHas(kind, R, i % n, (i / n) | 0, n)) continue;
      var cw = base.cwOf[i];
      if (cw < 0 || seen[cw]) continue;
      seen[cw] = 1;
      counts[plan.blockOf[cw]]++;
    }
    for (var b = 0; b < plan.blockCount; b++) {
      if (counts[b] > plan.tPerBlock[b] * factor) return false;
    }
    return true;
  }

  /**
   * The largest radius of this shape the error budget can hold: enough
   * codewords overall, and no single RS block over its share.
   */
  function surfaceRadiusForBudget(base, kind, budgetCw, factor, cap, n) {
    var R = 0;
    for (var r = 0.25; r <= cap; r += 0.25) {
      var c = surfaceCells(kind, r, n);
      // the heuristic is a stand-in when no base is available; with one, the
      // real codeword count decides
      if (!base && surfaceCodewords(c, r) > budgetCw) continue;
      if (base && !surfaceFitsBlocks(base, kind, r, factor)) continue;
      R = r;
    }
    return R;
  }

  /**
   * Surface geometry for a url + version. Two limits decide the size: the
   * number of codewords the error correction can spare, and the tightest RS
   * block (a block can only absorb so many sacrificed codewords). The
   * estimate is deliberately conservative — the grow pass, not this formula,
   * decides where the surface really ends.
   */
  function canvasShape(url, version, opts) {
    opts = opts || {};
    var kind = opts.surface || 'squircle';
    var aggression = opts.aggression !== undefined ? opts.aggression : 1.0;
    var plan = codePlan(version);
    var tSum = 0;
    for (var b = 0; b < plan.tPerBlock.length; b++) tSum += plan.tPerBlock[b];
    var padBits = 0;
    try { padBits = padShape(url, version).padCount * 8; } catch (e) { padBits = 0; }
    // The budget: codewords the error correction can spare. The planner
    // cannot use every one of them (a codeword that straddles the edge pins
    // fewer cells), so the estimate keeps a margin over the raw capacity.
    var budgetCw = tSum * 0.85 * aggression;
    var n = version * 4 + 17;
    var func = buildFunctionMask(version);
    var cap = surfaceCap(kind, n);
    // The placement walk does not depend on the mask, so one base is enough
    // to ask where the blocks sit.
    var base = null;
    try { base = buildBase(url, version, 0); } catch (e) { base = null; }
    var R = surfaceRadiusForBudget(base, kind, budgetCw, 0.95, cap, n);
    var shape = surfaceAt(kind, R, n, { cwBudget: tSum, padBits: padBits, func: func });
    return shape;
  }

  /**
   * The surface as a plain descriptor — what the fit works against. Accepts
   * either a surface object or the legacy {canvasR} pair.
   */
  function surfaceOf(opts, n) {
    if (opts && opts.surface && typeof opts.surface === 'object') return opts.surface;
    var kind = (opts && opts.surface) || 'squircle';
    var R = opts && opts.canvasR !== undefined ? opts.canvasR : 0;
    return surfaceAt(kind, R, n, null);
  }

  /** Residual mismatches inside the surface for a final module matrix. */
  function canvasResidual(modules, base, art, opts) {
    var tw = targetWeight(art, opts);
    var n = base.n;
    var surf = surfaceOf(opts, n);
    var out = { bg: 0, ink: 0, cells: 0 };
    for (var i = 0; i < n * n; i++) {
      if (base.func[i]) continue;
      if (!surfaceHas(surf.kind, surf.R, i % n, (i / n) | 0, n)) continue;
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
    var build = opts.build || buildBase;
    var base = build(url, version, mask, null);
    var pad = padSolve(base, art, opts);
    if (pad && pad.fixed > 0) base = pad.base;
    var plan = planFlips(base, art, opts);
    return { url: url, suffix: opts.suffix || '', mask: mask, base: base, plan: plan, score: plan.score, pad: pad };
  }

  /**
   * The workbench pipeline: surface sizing → encoding search (or reuse) → pad
   * solve → flip budget → decode verify — then check the promise: zero random
   * cells inside the surface. Retry order keeps the surface STABLE and as big
   * as possible: (1) the established/re-used encoding, (2) a full search,
   * (3) the runner-up encodings at the same radius, and only if everything
   * fails, (4) shrink one step and start over. After a clean fit the grow pass
   * pushes the surface out while the promise still holds — that is where the
   * free area gets as large as the error budget allows.
   * opts.reuse {mask, suffix} — fast path for painting (skip the search, keep
   * the established encoding).
   * opts.surface — 'squircle' | 'circle' | 'cross': the shape of the free area.
   * opts.grow — grow the surface while it still holds (default: on unless the
   * caller pinned the radius with opts.canvasR).
   * Returns { fit, t, canvas, residual, attempts }.
   */
  function fitWorkbench(url, version, art, opts) {
    opts = opts || {};
    var kind = typeof opts.surface === 'string' ? opts.surface
      : (opts.surface && opts.surface.kind) || 'squircle';
    var shape;
    if (opts.surface && typeof opts.surface === 'object') {
      shape = opts.surface;
    } else {
      shape = canvasShape(url, version, { surface: kind, aggression: opts.aggression });
    }
    if (opts.canvasR !== undefined) shape = surfaceAt(kind, opts.canvasR, shape.n, shape);
    if (shape.R <= 0 || shape.cells < 20) {
      throw 'not enough room to draw at version ' + version + ': try another surface or version';
    }
    var manual = typeof opts.mask === 'number';
    var last = null;
    var tried = {};
    var doneSearch = manual; // manual masks never run the search
    var attempts = 0;

    function evaluate(fit, surf) {
      surf = surf || shape;
      var t = autoTune(fit.base, art, {
        strength: 1.0,
        margin: opts.margin !== undefined ? opts.margin : 1.0,
        plan: fit.plan, style: opts.style, surface: surf, verify: opts.verify
      });
      var residual = canvasResidual(t.modules, fit.base, art, { surface: surf });
      attempts++;
      return { fit: fit, t: t, canvas: surf, residual: residual, attempts: attempts };
    }

    /**
     * The grow pass: the surface starts from the budget estimate, which is a
     * guess. This pushes it out in quarter-cell steps while the promise still
     * holds — zero random cells inside, every stroke realised, and the code
     * still decoding. It stops at the first step that breaks any of those, so
     * the surface ends up as large as the error budget genuinely allows.
     */
    function grow(res) {
      if (opts.grow === false) return res;
      if (opts.grow === undefined && opts.canvasR !== undefined) return res;
      var cap = opts.surfaceCap !== undefined ? opts.surfaceCap : surfaceCap(kind, shape.n);
      var best = res;
      for (var step = 0; step < 16; step++) {
        var R2 = best.canvas.R + 0.25;
        if (R2 > cap) break;
        var o = {};
        for (var k in opts) o[k] = opts[k];
        var surf = surfaceAt(kind, R2, shape.n, res.canvas);
        o.surface = surf;
        o.mask = best.fit.mask;
        o.suffix = best.fit.suffix || '';
        var fit = manualFit(url + o.suffix, version, art, o);
        var t = autoTune(fit.base, art, {
          strength: 1.0,
          margin: opts.margin !== undefined ? opts.margin : 1.0,
          plan: fit.plan, style: opts.style, surface: surf, verify: opts.verify
        });
        var residual = canvasResidual(t.modules, fit.base, art, { surface: surf });
        attempts++;
        if (residual.bg !== 0 || residual.ink !== 0 || !t.verified) break;
        best = { fit: fit, t: t, canvas: surf, residual: residual, attempts: attempts };
      }
      return best;
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
        o.surface = shape;
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
        if (last.residual.bg === 0 && last.residual.ink === 0) return grow(last);
      }
      // still stray cells: shrink one step and try again at the smaller radius
      var n2 = shape.n;
      var R2 = shape.R - 0.25;
      while (R2 > 0 && surfaceCells(kind, R2, n2) >= shape.cells) R2 -= 0.25;
      if (R2 <= 0) break;
      shape = surfaceAt(kind, R2, n2, shape);
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
    if (opts.canvasR !== undefined || (opts.surface && typeof opts.surface === 'object')) {
      // Workbench mode: strict surface. Inside: pinned to the drawing
      // (ink dark, everything else light). Outside: the code ring — the QR's
      // own randomness, only lightly discouraged from spending budget.
      var surf = surfaceOf(opts, n);
      for (var c = 0; c < n2; c++) {
        var inside = surfaceHas(surf.kind, surf.R, c % n, (c / n) | 0, n);
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
      surface: opts.surface,
      canvasR: opts.canvasR
    };
    var suffixes = [''];
    if (url.indexOf('#') === -1) {
      suffixes.push('#'); // 1 extra byte: leaves a pad codeword AND a free fragment byte
      var alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
      for (var a = 0; a < alphabet.length; a++) suffixes.push('#' + alphabet[a]);
    }
    var candidates = [];
    var build = opts.build || buildBase;
    for (var s = 0; s < suffixes.length; s++) {
      for (var m = 0; m < 8; m++) {
        var base;
        try {
          base = build(url + suffixes[s], version, m, null);
        } catch (e) {
          continue; // suffix doesn't fit this version — skip
        }
        var plan = planFlips(base, art, flipOpts);
        candidates.push({ url: url + suffixes[s], suffix: suffixes[s], mask: m, base: base, plan: plan, score: plan.score });
      }
    }
    if (!candidates.length) {
      // fall back: base without suffix, mask 0
      var b0 = build(url, version, 0, null);
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
  function renderRGBA(modules, n, box, border, style, opts) {
    style = style || 'square';
    opts = opts || {};
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
    // The finder patterns: the standard three corners, or wherever a custom
    // layout puts them.
    var finders = opts.finders || [{ x: 0, y: 0 }, { x: n - 7, y: 0 }, { x: 0, y: n - 7 }];
    var inFinder = function (x, y) {
      for (var fi = 0; fi < finders.length; fi++) {
        var f = finders[fi];
        if (x >= f.x && x < f.x + 7 && y >= f.y && y < f.y + 7) return true;
      }
      return false;
    };
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (!modules[y * n + x] || inFinder(x, y)) continue;
        paintZone(x, y, 1, modInside);
      }
    }
    var eyeInside = shapes.eye;
    var zones = [];
    for (var z = 0; z < finders.length; z++) zones.push([finders[z].x, finders[z].y]);
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

  // ------------------------------- round output -------------------------------
  // A profile picture is a circle, and a circle has no corners: the three
  // finder patterns of a square QR sit exactly where a circular crop would
  // eat them. Two ways out, one for each pipeline:
  //
  //   standard — the QR square is INSCRIBED in the circle, so all three eyes
  //              are inside it and the code is a standard one. The circle is
  //              the quiet zone.
  //   custom   — the grid is a disc, so the code fills the circle edge to
  //              edge and the finder patterns live inside it.

  /**
   * The round avatar geometry for a standard QR: the square is inscribed in
   * the circle, so its corners (the eyes) touch the rim. `shrink` pulls it
   * in a touch, so the eyes sit clear of the edge.
   */
  function roundLayout(n, D, shrink) {
    shrink = shrink || 0.94;
    var r = (D / 2) * shrink;
    var box = Math.max(1, Math.floor((r * Math.SQRT2) / n));
    var side = box * n;
    return { box: box, side: side, off: Math.round((D - side) / 2), size: D, shrink: shrink };
  }

  /**
   * A round avatar of a standard QR: white inside the circle, transparent
   * outside it, the code inscribed so every finder pattern survives the crop.
   */
  function renderRoundRGBA(modules, n, D, style, opts) {
    opts = opts || {};
    var lay = roundLayout(n, D, opts.shrink);
    if (opts.box) lay.box = opts.box;
    lay.side = lay.box * n;
    lay.off = Math.round((D - lay.side) / 2);
    var q = renderRGBA(modules, n, lay.box, 0, style, opts);
    var data = new Uint8ClampedArray(D * D * 4);
    var R = D / 2;
    for (var y = 0; y < D; y++) {
      for (var x = 0; x < D; x++) {
        var p = (y * D + x) * 4;
        var dx = x + 0.5 - R, dy = y + 0.5 - R;
        if (dx * dx + dy * dy > R * R) {
          // outside the circle: transparent — but white in the colour channels,
          // so a decoder that ignores alpha still sees a quiet zone
          data[p] = data[p + 1] = data[p + 2] = 255;
          data[p + 3] = 0;
          continue;
        }
        data[p] = data[p + 1] = data[p + 2] = 255;
        data[p + 3] = 255;
        var qx = x - lay.off, qy = y - lay.off;
        if (qx >= 0 && qy >= 0 && qx < lay.side && qy < lay.side) {
          var s = (qy * q.width + qx) * 4;
          data[p] = q.data[s]; data[p + 1] = q.data[s + 1]; data[p + 2] = q.data[s + 2];
        }
      }
    }
    return { data: data, width: D, height: D, layout: lay };
  }

  /**
   * The avatar's module size: the largest that still decodes. A styled render
   * is not perfectly scale-invariant — at one size in twenty a finder pattern
   * can blur just enough to lose it — so the export walks down a few sizes
   * and keeps the first a real decoder reads. Without a url to check against
   * it just returns the nominal size.
   */
  function roundAvatarBox(modules, n, D, style, opts) {
    opts = opts || {};
    var lay = roundLayout(n, D, opts.shrink);
    if (!opts.url) return lay.box;
    for (var k = 0; k < 4; k++) {
      var box = lay.box - k;
      if (box < 1) break;
      var img = renderRoundRGBA(modules, n, D, style, {
        shrink: opts.shrink, box: box, finders: opts.finders
      });
      if (decodeRGBA(img) === opts.url) return box;
    }
    return lay.box;
  }

  /**
   * A round avatar of the custom layout: the disc is drawn edge to edge and
   * everything outside it is transparent, so the code fills the circle.
   */
  function renderDiscRGBA(modules, G, layout, D, style, opts) {
    opts = opts || {};
    var shrink = opts.shrink || 0.97;
    var box = Math.max(1, Math.floor((D / 2) * shrink / (layout.rDisc + 0.5)));
    var off = Math.round((D - box * G) / 2);
    var q = renderRGBA(modules, G, box, 0, style, { finders: customFinderCorners(layout) });
    var data = new Uint8ClampedArray(D * D * 4);
    var R = D / 2;
    for (var y = 0; y < D; y++) {
      for (var x = 0; x < D; x++) {
        var p = (y * D + x) * 4;
        var dx = x + 0.5 - R, dy = y + 0.5 - R;
        if (dx * dx + dy * dy > R * R) {
          data[p] = data[p + 1] = data[p + 2] = 255;
          data[p + 3] = 0;
          continue; // outside the circle: transparent
        }
        data[p] = data[p + 1] = data[p + 2] = 255;
        data[p + 3] = 255;
        var qx = x - off, qy = y - off;
        if (qx >= 0 && qy >= 0 && qx < q.width && qy < q.height) {
          var s = (qy * q.width + qx) * 4;
          var a = q.data[s + 3];
          if (a) {
            data[p] = q.data[s]; data[p + 1] = q.data[s + 1]; data[p + 2] = q.data[s + 2];
          }
        }
      }
    }
    return { data: data, width: D, height: D, layout: { box: box, off: off, size: D } };
  }

  /** The top-left corners of the custom layout's finder patterns. */
  function customFinderCorners(layout) {
    var out = [];
    for (var i = 0; i < layout.finders.length; i++) {
      out.push({ x: layout.finders[i].x - 3, y: layout.finders[i].y - 3 });
    }
    return out;
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
    // The verifier: the standard pipeline decodes the rendered code with a
    // real decoder (jsQR); a custom pipeline brings its own.
    var verifyFn = opts.verify || function (modules, b) {
      return verify(modules, b.n, b.url, opts.style);
    };

    var baseline = verifyFn(base.modules, base);
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
      var res = verifyFn(applied.modules, base);
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
    var baseRes = verifyFn(base.modules, base);
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

  // ------------------------------ RS decoding ---------------------------------
  // GF(256) with the QR primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d).
  // The standard pipeline verifies itself with jsQR (a real decoder); the
  // custom pipeline has no such luxury, so the engine carries its own
  // Reed-Solomon decoder: syndromes, Berlekamp-Massey, Chien search, Forney.

  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
  function gdiv(a, b) { return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]; }

  function polyEval(p, xv) {
    var v = 0, xp = 1;
    for (var i = 0; i < p.length; i++) { v ^= gmul(p[i], xp); xp = gmul(xp, xv); }
    return v;
  }

  /**
   * Correct one Reed-Solomon block. `msg` is the codeword (data then error
   * codewords, highest degree first); `ecCount` is the number of error
   * codewords. Returns the corrected data bytes, or null when the block is
   * beyond repair.
   */
  function rsDecode(msg, ecCount) {
    var n = msg.length, i, j;
    var synd = [];
    for (i = 0; i < ecCount; i++) {
      var s = 0;
      for (j = 0; j < n; j++) s = gmul(s, EXP[i]) ^ msg[j];
      synd.push(s);
    }
    var any = false;
    for (i = 0; i < ecCount; i++) if (synd[i]) { any = true; break; }
    if (!any) return msg.slice(0, n - ecCount);

    // Berlekamp-Massey: the error locator sigma(x)
    var sigma = [1], old = [1], L = 0, m = 1, b = 1;
    for (i = 0; i < ecCount; i++) {
      var delta = synd[i];
      for (j = 1; j <= L; j++) delta ^= gmul(sigma[j], synd[i - j]);
      if (delta === 0) { m++; continue; }
      var scale = gdiv(delta, b);
      var t = (2 * L <= i) ? sigma.slice() : null;
      for (j = 0; j < old.length; j++) {
        while (sigma.length <= j + m) sigma.push(0);
        sigma[j + m] ^= gmul(scale, old[j]);
      }
      if (t) { L = i + 1 - L; old = t; b = delta; m = 1; } else m++;
    }

    // Chien search: a root of sigma means an error at that codeword
    var errs = [];
    for (var k = 0; k < n; k++) {
      var deg = n - 1 - k;
      var xk = EXP[(255 - (deg % 255)) % 255];
      var sum = 0, xp = 1;
      for (var q = 0; q < sigma.length; q++) { sum ^= gmul(sigma[q], xp); xp = gmul(xp, xk); }
      if (sum === 0) errs.push(k);
    }
    if (errs.length !== L) return null;

    // Forney: omega(x) = S(x)·sigma(x) mod x^ecCount, and the derivative
    var omega = [];
    for (i = 0; i < ecCount; i++) {
      var acc = 0;
      for (j = 0; j <= i; j++) if (sigma[j]) acc ^= gmul(sigma[j], synd[i - j]);
      omega.push(acc);
    }
    var dsigma = [];
    for (i = 1; i < sigma.length; i += 2) dsigma[i - 1] = sigma[i];

    var out = msg.slice();
    for (i = 0; i < errs.length; i++) {
      k = errs[i];
      deg = n - 1 - k;
      var Xi = EXP[deg % 255];
      var XiInv = EXP[(255 - (deg % 255)) % 255];
      var den = polyEval(dsigma, XiInv);
      if (den === 0) return null;
      out[k] ^= gmul(gdiv(polyEval(omega, XiInv), den), Xi);
    }
    for (i = 0; i < ecCount; i++) {
      var s2 = 0;
      for (j = 0; j < n; j++) s2 = gmul(s2, EXP[i]) ^ out[j];
      if (s2 !== 0) return null; // still broken — refuse the block
    }
    return out.slice(0, n - ecCount);
  }

  /** The payload out of a block's data codewords (byte mode). */
  function parsePayload(bytes, version) {
    var countBits = version <= 9 ? 8 : 16;
    function readBits(pos, len) {
      var v = 0;
      for (var i = 0; i < len; i++) {
        v = (v << 1) | ((bytes[(pos + i) >> 3] >> (7 - ((pos + i) & 7))) & 1);
      }
      return v;
    }
    if (bytes.length < 3) return null;
    var mode = readBits(0, 4);
    if (mode !== 4) return null; // byte mode only
    var len = readBits(4, countBits);
    var need = 4 + countBits + len * 8;
    if (need > bytes.length * 8) return null;
    var raw = [];
    for (var i = 0; i < len; i++) raw.push(readBits(4 + countBits + i * 8, 8));
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('utf-8').decode(new Uint8Array(raw)); } catch (e) { /* fall through */ }
    }
    var out = '';
    for (i = 0; i < raw.length; i++) out += String.fromCharCode(raw[i]);
    return out;
  }

  /**
   * The smallest version that can carry this url at level H — and, if asked,
   * that has room to draw in. The version list uses it to grey out the
   * versions that could never work for this link, so nobody picks one and
   * gets a "code length overflow" instead of a code.
   */
  function minVersion(url, opts) {
    opts = opts || {};
    var bytes = utf8Len(url);
    for (var v = MIN_VERSION; v <= MAX_VERSION; v++) {
      var plan = codePlan(v);
      var totalData = 0;
      for (var r = 0; r < plan.rsBlocks.length; r++) totalData += plan.rsBlocks[r].dataCount;
      var countBits = v <= 9 ? 8 : 16;
      var bits = 4 + countBits + bytes * 8;
      if (bits + 4 <= totalData * 8) bits += 4;
      if (Math.ceil(bits / 8) > totalData) continue; // the link does not fit
      var shape = opts.pipeline === 'custom'
        ? customShape(url, v)
        : canvasShape(url, v, { surface: opts.surface });
      if (shape.R <= 0 || shape.cells < 20) continue; // no room to draw
      return v;
    }
    return MAX_VERSION;
  }

  /**
   * The custom pipeline's free surface: a circle in the middle of the disc,
   * sized by the same budget rules as the standard one (codewords overall, and
   * no single RS block over its share), and never reaching the finder
   * patterns.
   */
  function customShape(url, version) {
    var lay = customLayout(version);
    var plan = codePlan(version);
    var tSum = 0;
    for (var b = 0; b < plan.tPerBlock.length; b++) tSum += plan.tPerBlock[b];
    var budgetCw = tSum * 0.85;
    // the drawing may not reach the finder patterns
    var cap = Math.max(2, lay.dFind - 5);
    // the same budget rules as the standard pipeline: codewords overall,
    // and no single RS block over its share
    var base = null;
    try { base = buildCustom(url, version, 0, null, lay); } catch (e) { base = null; }
    var R = surfaceRadiusForBudget(base, 'circle', budgetCw, 0.95, cap, lay.G);
    return surfaceAt('circle', R, lay.G, { func: lay.func, layout: lay });
  }

  // -------------------------- the custom pipeline -----------------------------
  // A second backend, and our own: instead of the standard square QR, a
  // circle-native one. The module grid is a DISC, not a square, so the code
  // fills a round avatar edge to edge; the three finder patterns sit inside
  // it, 120° apart, where a square QR would have put them on the corners —
  // and a circular crop eats the corners. The payload, the Reed-Solomon
  // coding, the interleaving and the mask are all the standard ones; only the
  // LAYOUT is ours. So it is not a standard QR: nothing but a decoder that
  // knows this layout reads it.

  var FINDER_BLOCK = 81; // 7×7 finder + a one-cell light ring (the separator)

  /** The K cells nearest the centre of a G×G grid — a disc. */
  function discCells(K, G) {
    var c = (G - 1) / 2;
    var cells = [];
    for (var y = 0; y < G; y++) {
      for (var x = 0; x < G; x++) {
        var dx = x - c, dy = y - c;
        cells.push({ x: x, y: y, d: dx * dx + dy * dy, i: y * G + x });
      }
    }
    cells.sort(function (a, b) { return a.d - b.d || a.i - b.i; });
    return cells.slice(0, K);
  }

  /**
   * The custom layout: a disc of modules with three finder patterns inside it.
   * The disc's size is fixed by the version — it must hold exactly the code
   * words of the payload — and the finders are placed as far out as they fit,
   * leaving the middle for the drawing.
   */
  function customLayout(version, opts) {
    opts = opts || {};
    var plan = codePlan(version);
    var remainder = REMAINDER_BITS[version] || 0;
    var dataCells = plan.totalCw * 8 + remainder;
    var K = dataCells + 3 * FINDER_BLOCK;
    var guess = Math.ceil(Math.sqrt(K / Math.PI)) + 3;
    var G = 2 * guess + 1;
    var disc = discCells(K, G);
    var c = (G - 1) / 2;
    var rDisc = 0;
    for (var i = 0; i < disc.length; i++) {
      var d = Math.sqrt(disc[i].d);
      if (d > rDisc) rDisc = d;
    }

    // The three finders: 120° apart, as far out as the disc allows.
    var inDisc = new Uint8Array(G * G);
    for (i = 0; i < disc.length; i++) inDisc[disc[i].i] = 1;
    function fits(dFind) {
      for (var a = 0; a < 3; a++) {
        var ang = -Math.PI / 2 + a * 2 * Math.PI / 3;
        var fx = Math.round(c + dFind * Math.cos(ang));
        var fy = Math.round(c + dFind * Math.sin(ang));
        for (var dy = -4; dy <= 4; dy++) {
          for (var dx = -4; dx <= 4; dx++) {
            var x = fx + dx, y = fy + dy;
            if (x < 0 || y < 0 || x >= G || y >= G) return false;
            if (!inDisc[y * G + x]) return false;
          }
        }
      }
      return true;
    }
    var dFind = rDisc - 1;
    while (dFind > 4 && !fits(dFind)) dFind -= 0.5;
    if (!fits(dFind)) dFind = Math.max(2, rDisc - 7);

    var func = new Uint8Array(G * G);
    var finders = [];
    for (var a2 = 0; a2 < 3; a2++) {
      var ang2 = -Math.PI / 2 + a2 * 2 * Math.PI / 3;
      var fx2 = Math.round(c + dFind * Math.cos(ang2));
      var fy2 = Math.round(c + dFind * Math.sin(ang2));
      finders.push({ x: fx2, y: fy2 });
      for (var dy2 = -4; dy2 <= 4; dy2++) {
        for (var dx2 = -4; dx2 <= 4; dx2++) {
          var x2 = fx2 + dx2, y2 = fy2 + dy2;
          if (x2 >= 0 && y2 >= 0 && x2 < G && y2 < G) func[y2 * G + x2] = 1;
        }
      }
    }

    // The walk: column pairs right to left, rows alternating, disc cells only.
    var order = [];
    var col = G - 1, upward = true;
    while (col > 0) {
      for (var k = 0; k < G; k++) {
        var y3 = upward ? (G - 1 - k) : k;
        for (var dxc = 0; dxc < 2; dxc++) {
          var x3 = col - dxc;
          var idx = y3 * G + x3;
          if (!inDisc[idx] || func[idx]) continue;
          order.push(idx);
        }
      }
      upward = !upward;
      col -= 2;
    }

    return {
      version: version, G: G, c: c, rDisc: rDisc, dFind: dFind,
      disc: disc, inDisc: inDisc, func: func, order: order, finders: finders,
      plan: plan, dataCells: dataCells, remainder: remainder
    };
  }

  /** Paint the three finder patterns (7×7 with a one-cell light ring). */
  function drawCustomFinders(modules, layout) {
    var G = layout.G;
    for (var f = 0; f < layout.finders.length; f++) {
      var fx = layout.finders[f].x, fy = layout.finders[f].y;
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var x = fx + dx, y = fy + dy;
          if (x < 0 || y < 0 || x >= G || y >= G) continue;
          var ring = (Math.abs(dx) === 3 || Math.abs(dy) === 3);
          var core = (Math.abs(dx) <= 1 && Math.abs(dy) <= 1);
          modules[y * G + x] = (ring || core) ? 1 : 0;
        }
      }
    }
  }

  /**
   * Build the custom base: the standard code words, placed in our layout.
   * The payload, the RS coding, the interleaving and the mask are the
   * standard ones — only the grid and the finder positions are ours.
   */
  function buildCustom(url, version, mask, padBytes, layout) {
    var std = buildBase(url, version, mask, padBytes);
    var bits = extractPreMaskBits(std.modules, std.order, mask, std.n);
    var G = layout.G;
    var modules = new Uint8Array(G * G);
    drawCustomFinders(modules, layout);
    for (var p = 0; p < layout.order.length && p < bits.length; p++) {
      var i = layout.order[p];
      var y = (i / G) | 0, x = i % G;
      var bit = bits[p] ? 1 : 0;
      modules[i] = maskAt(mask, y, x) ? (bit ? 0 : 1) : bit;
    }
    var cwOf = new Int32Array(G * G).fill(-1);
    var cwBits = layout.plan.totalCw * 8;
    for (var q = 0; q < layout.order.length && q < cwBits; q++) cwOf[layout.order[q]] = q >> 3;
    var drawable = 0;
    for (var z = 0; z < G * G; z++) if (!layout.func[z]) drawable++;
    return {
      n: G, version: version, mask: mask, url: url, modules: modules,
      func: layout.func, drawable: drawable, order: layout.order,
      plan: layout.plan, cwOf: cwOf, remainder: layout.order.length - cwBits,
      layout: layout, grid: G
    };
  }

  /** Read the custom layout back: the walk, the mask, the RS correction. */
  function decodeCustom(modules, layout, mask) {
    var G = layout.G;
    var bits = new Uint8Array(layout.order.length);
    for (var p = 0; p < layout.order.length; p++) {
      var i = layout.order[p];
      var y = (i / G) | 0, x = i % G;
      bits[p] = modules[i] ^ (maskAt(mask, y, x) ? 1 : 0);
    }
    var plan = layout.plan;
    var bytes = [];
    for (var c = 0; c < plan.totalCw; c++) {
      var b = 0;
      for (var k = 0; k < 8; k++) b = (b << 1) | bits[c * 8 + k];
      bytes.push(b);
    }
    var blocks = [];
    for (var r = 0; r < plan.blockCount; r++) blocks.push([]);
    var idx = 0;
    for (var i = 0; i < plan.maxDc; i++) {
      for (var r2 = 0; r2 < plan.blockCount; r2++) if (i < plan.rsBlocks[r2].dataCount) blocks[r2].push(bytes[idx++]);
    }
    for (var i2 = 0; i2 < plan.maxEc; i2++) {
      for (var r3 = 0; r3 < plan.blockCount; r3++) {
        if (i2 < (plan.rsBlocks[r3].totalCount - plan.rsBlocks[r3].dataCount)) blocks[r3].push(bytes[idx++]);
      }
    }
    var data = [];
    for (var r4 = 0; r4 < blocks.length; r4++) {
      var ec = plan.rsBlocks[r4].totalCount - plan.rsBlocks[r4].dataCount;
      var fixed = rsDecode(blocks[r4], ec);
      if (!fixed) return null;
      for (var q2 = 0; q2 < plan.rsBlocks[r4].dataCount; q2++) data.push(fixed[q2]);
    }
    return parsePayload(data, layout.version);
  }

  // ------------------------------- pipelines ----------------------------------
  // A pipeline turns a url and a drawing into a module matrix. Two are built in:
  //
  //   standard — the ordinary QR: a square grid, the finder patterns on the
  //              corners, and a free surface in the middle that the error
  //              budget keeps clean. Every scanner reads it.
  //   custom   — our own layout: a circular grid with the finder patterns
  //              inside it, so the code fills a round avatar edge to edge.
  //              Nothing but a decoder that knows the layout reads it.
  //
  // registerPipeline(name, def) adds another one; fitWorkbench takes
  // opts.pipeline (a name or a definition).

  var PIPELINES = {};

  function registerPipeline(name, def) {
    def.name = name;
    PIPELINES[name] = def;
    return def;
  }

  function pipelineOf(spec) {
    if (!spec) return PIPELINES.standard;
    if (typeof spec === 'string') {
      var p = PIPELINES[spec];
      if (!p) throw 'unknown pipeline: ' + spec;
      return p;
    }
    return spec;
  }

  registerPipeline('standard', {
    label: 'standard QR',
    hint: 'The ordinary QR code. Any phone camera reads it.',
    scannable: true,
    surface: 'squircle',
    grid: function (url, version) { return version * 4 + 17; },
    build: function (url, version, mask, padBytes) { return buildBase(url, version, mask, padBytes); },
    fit: function (url, version, art, opts) { return fitWorkbench(url, version, art, opts); }
  });

  registerPipeline('custom', {
    label: 'custom circle',
    hint: 'My own layout: a circular grid with the finder patterns inside it, ' +
          'so the code fills a round avatar edge to edge. Only a decoder that ' +
          'knows the layout reads it.',
    scannable: false,
    surface: 'circle',
    layout: function (url, version) { return customLayout(version); },
    grid: function (url, version) { return customLayout(version).G; },
    build: function (url, version, mask, padBytes) {
      return buildCustom(url, version, mask, padBytes, customLayout(version));
    },
    verify: function (modules, base) {
      var ok = decodeCustom(modules, base.layout, base.mask) === base.url;
      return { clean: ok, stressed: ok };
    },
    fit: function (url, version, art, opts) {
      var lay = customLayout(version);
      var shape = customShape(url, version);
      var o = {};
      for (var k in opts) o[k] = opts[k];
      o.surface = shape;
      o.surfaceCap = Math.max(2, lay.dFind - 5);
      o.build = function (u, v, m, pads) { return buildCustom(u, v, m, pads, lay); };
      o.verify = this.verify;
      o.cacheKey = 'custom';
      return fitWorkbench(url, version, art, o);
    }
  });

  /** SVG export of a final module matrix (style-aware). */
  function toSVG(modules, n, box, border, style, opts) {
    box = box || 12; border = border || 4;
    style = style || 'square';
    opts = opts || {};
    var size = (n + 2 * border) * box;
    var parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
                 '" viewBox="0 0 ' + size + ' ' + size + '"' +
                 (style === 'square' ? ' shape-rendering="crispEdges"' : '') + '>',
                 '<rect width="' + size + '" height="' + size + '" fill="#fff"/>'];
    var defs = [];
    var finders = opts.finders || [{ x: 0, y: 0 }, { x: n - 7, y: 0 }, { x: 0, y: n - 7 }];
    var inFinder = function (x, y) {
      for (var fi = 0; fi < finders.length; fi++) {
        var f = finders[fi];
        if (x >= f.x && x < f.x + 7 && y >= f.y && y < f.y + 7) return true;
      }
      return false;
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
      var zones = [];
      for (var z = 0; z < finders.length; z++) zones.push([finders[z].x, finders[z].y]);
      for (var f = 0; f < zones.length; f++) {
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
    alignmentPatterns: alignmentPatterns,
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
    surfaceHas: surfaceHas,
    surfaceCells: surfaceCells,
    surfaceWidth: surfaceWidth,
    surfaceCap: surfaceCap,
    surfaceAt: surfaceAt,
    surfaceRadiusFor: surfaceRadiusFor,
    surfaceOf: surfaceOf,
    SURFACE_KINDS: SURFACE_KINDS,
    SURFACE_LABELS: SURFACE_LABELS,
    MIN_VERSION: MIN_VERSION,
    MAX_VERSION: MAX_VERSION,
    ALIGN_POS: ALIGN_POS,
    planFlips: planFlips,
    applyPlan: applyPlan,
    optimizeEncoding: optimizeEncoding,
    renderRGBA: renderRGBA,
    blurRGBA: blurRGBA,
    decodeRGBA: decodeRGBA,
    verify: verify,
    renderRoundRGBA: renderRoundRGBA,
    renderDiscRGBA: renderDiscRGBA,
    roundLayout: roundLayout,
    roundAvatarBox: roundAvatarBox,
    customLayout: customLayout,
    customShape: customShape,
    minVersion: minVersion,
    buildCustom: buildCustom,
    decodeCustom: decodeCustom,
    discCells: discCells,
    rsDecode: rsDecode,
    parsePayload: parsePayload,
    PIPELINES: PIPELINES,
    registerPipeline: registerPipeline,
    pipelineOf: pipelineOf,
    autoTune: autoTune,
    realizedInk: realizedInk,
    scoreMask: scoreMask,
    bestMask: bestMask,
    toSVG: toSVG,
    selfTest: selfTest
  };
});
