/**
 * PixelQR's reader.
 *
 * It reads our custom codes out of a picture, and it defines the format they
 * use — the generator builds to the same spec, so the two cannot drift.
 *
 * A custom code is not a standard QR: its grid is a disc, not a square, and
 * its finder patterns sit inside it, 120 degrees apart. A phone camera cannot
 * read one. This file can, on its own, with nothing else from the project:
 *
 *     <script src="reader.js"></script>
 *     ...
 *     var got = PixelQRReader.readImage(pixels, width, height);
 *     if (got) console.log(got.url, got.version);
 *
 * In node:
 *
 *     const reader = require('./reader.js');
 *
 * The pixels are RGBA, four bytes each. A standard QR is read too, if a
 * decoder is handed over (the browser's jsQR, say) — the engine passes its
 * own; the reader does not need one for our codes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null);
  } else {
    root.PixelQRReader = factory(root.jsQR || null);
  }
})(typeof self !== 'undefined' ? self : this, function (jsQR) {
  'use strict';

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


  // How many code words a version holds, data and error correction together
  // (ISO/IEC 18004, level H). The layout's size follows from it, so the
  // reader carries the table rather than the encoder that knows it.
  var BLOCKS = {
    3: { data: [13, 13], ec: 22 },
    4: { data: [9, 9, 9, 9], ec: 16 },
    5: { data: [11, 11, 12, 12], ec: 22 },
    6: { data: [15, 15, 15, 15], ec: 28 },
    7: { data: [13, 13, 13, 13, 14], ec: 26 },
    8: { data: [14, 14, 14, 14, 15, 15], ec: 26 },
    9: { data: [12, 12, 12, 12, 13, 13, 13, 13], ec: 24 },
    10: { data: [15, 15, 15, 15, 15, 15, 16, 16], ec: 28 },
    11: { data: [12, 12, 12, 13, 13, 13, 13, 13, 13, 13, 13], ec: 24 },
    12: { data: [14, 14, 14, 14, 14, 14, 14, 15, 15, 15, 15], ec: 28 },
    13: { data: [11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 12, 12, 12, 12], ec: 22 },
  };
  var REMAINDER_BITS = 7;  // the spare bits at the end, v2 to v13
  var MIN_VERSION = 3;     // the versions our codes use
  var MAX_VERSION = 13;

  /**
   * The Reed-Solomon block structure of a version, in the shape the decoder
   * wants: the blocks, how many data code words in each, how many error code
   * words, and the error-correction capacity of a block.
   */
  function planFor(version) {
    var b = BLOCKS[version];
    if (!b) return null;
    var rsBlocks = [];
    var totalCw = 0, i;
    for (i = 0; i < b.data.length; i++) {
      rsBlocks.push({ dataCount: b.data[i], totalCount: b.data[i] + b.ec });
      totalCw += b.data[i] + b.ec;
    }
    var maxDc = Math.max.apply(null, b.data);
    var tPerBlock = rsBlocks.map(function () { return Math.floor(b.ec / 2); });
    // the block each code word belongs to, in the order they go on the wire
    var blockOf = [];
    var i2, r2;
    for (i2 = 0; i2 < maxDc; i2++) {
      for (r2 = 0; r2 < rsBlocks.length; r2++) {
        if (i2 < rsBlocks[r2].dataCount) blockOf.push(r2);
      }
    }
    for (i2 = 0; i2 < b.ec; i2++) {
      for (r2 = 0; r2 < rsBlocks.length; r2++) blockOf.push(r2);
    }
    return {
      rsBlocks: rsBlocks, blockCount: rsBlocks.length, maxDc: maxDc, maxEc: b.ec,
      totalCw: totalCw, tPerBlock: tPerBlock, blockOf: blockOf
    };
  }

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
    var plan = planFor(version);
    if (!plan) return null;
    var remainder = REMAINDER_BITS;
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

  // ------------------------------ the format block -----------------------------
  // A standard QR keeps the mask and the version in metadata beside the first
  // finder pattern. Ours has none, so the reader has to search for both. The
  // eyes' separator rings can carry the same thing: that ring is structure, so
  // nothing can paint over it, and it sits out in the rim where the drawing
  // never reaches.
  //
  // Fifteen cells per eye: the version (4 bits), the mask (3 bits) and a
  // checksum (8 bits), so a misread eye is caught rather than believed.

  var FORMAT_BITS = 15;

  /** The ring cells that carry the format, in bit order, round one eye. */
  function formatCells(fx, fy) {
    var cells = [];
    for (var i = 0; i < 9; i++) cells.push({ x: fx - 4 + i, y: fy + 4 });
    for (var j = 0; j < 6; j++) cells.push({ x: fx + 4, y: fy + 3 - j });
    return cells;
  }

  /** CRC-8 (0x07) over the version and the mask. */
  function formatCrc(byte) {
    var crc = 0;
    for (var i = 0; i < 8; i++) {
      var bit = (byte >> (7 - i)) & 1;
      var top = (crc >> 7) & 1;
      crc = ((crc << 1) | bit) & 0xff;
      if (top) crc ^= 0x07;
    }
    return crc;
  }

  /** The format bits: version, mask, checksum. */
  function formatBits(version, mask) {
    var data = ((version & 0xf) << 3) | (mask & 7);
    var crc = formatCrc(data);
    var bits = [];
    for (var v = 6; v >= 3; v--) bits.push((data >> v) & 1);   // the version
    for (var m = 2; m >= 0; m--) bits.push((data >> m) & 1);   // the mask
    for (var c = 7; c >= 0; c--) bits.push((crc >> c) & 1);    // the checksum
    return bits;
  }

  /** Read the format back out of a sampled module matrix. */
  function readFormat(lay, mods) {
    var cells = formatCells(lay.finders[0].x, lay.finders[0].y);
    var bits = [];
    for (var i = 0; i < cells.length && i < FORMAT_BITS; i++) {
      bits.push(mods[cells[i].y * lay.G + cells[i].x] ? 1 : 0);
    }
    if (bits.length < FORMAT_BITS) return null;
    var version = 0, mask = 0, crc = 0;
    for (var b = 0; b < 4; b++) version = (version << 1) | bits[b];
    for (var m = 0; m < 3; m++) mask = (mask << 1) | bits[4 + m];
    for (var c = 0; c < 8; c++) crc = (crc << 1) | bits[7 + c];
    var data = ((version & 0xf) << 3) | (mask & 7);
    if (formatCrc(data) !== crc) return null;
    if (version < MIN_VERSION || version > MAX_VERSION) return null;
    return { version: version, mask: mask };
  }

  /** Sample just the format cells of a layout out of a picture. */
  function sampleFormat(lay, data, width, height, box, s, dx, dy) {
    var G = lay.G;
    var ox = box.x0 + box.w / 2 + dx - ((G - 1) / 2) * s;
    var oy = box.y0 + box.h / 2 + dy - ((G - 1) / 2) * s;
    var cells = formatCells(lay.finders[0].x, lay.finders[0].y);
    var mods = new Uint8Array(G * G);
    for (var i = 0; i < cells.length; i++) {
      var px = Math.round(ox + cells[i].x * s);
      var py = Math.round(oy + cells[i].y * s);
      if (px < 0 || py < 0 || px >= width || py >= height) return null;
      var p = (py * width + px) * 4;
      var lum = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
      mods[cells[i].y * G + cells[i].x] = lum < 128 ? 1 : 0;
    }
    return mods;
  }

  /**
   * The format block is the arbiter: the search finds roughly where the code
   * is, and this fine search around that fit finds the exact scale and
   * position — the ones the checksum agrees with. With them the mask is known
   * too, so the code is read in one go instead of eight.
   */
  function readFormatNear(lay, data, width, height, box, s, mx, my) {
    for (var t = -8; t <= 8; t++) {
      var s2 = s * (1 + t * 0.005);
      for (var dy = -10; dy <= 10; dy++) {
        for (var dx = -10; dx <= 10; dx++) {
          var ox = mx + dx * 0.1 * s2, oy = my + dy * 0.1 * s2;
          var mods = sampleFormat(lay, data, width, height, box, s2, ox, oy);
          if (!mods) continue;
          var fmt = readFormat(lay, mods);
          if (fmt && fmt.version === lay.version) {
            return { s: s2, mx: ox, my: oy, mask: fmt.mask };
          }
        }
      }
    }
    return null;
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

  // ------------------------------ reading images -------------------------------
  // The other half of the engine: a code goes into an image, and comes back
  // out of one. A standard QR goes to jsQR. One of ours goes through the
  // custom layout: the disc's cells are the ones nearest the centre, so the
  // shape of the picture gives the grid.

  /** The grid rectangle the disc's cells occupy. */
  function discBounds(layout) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < layout.disc.length; i++) {
      var c = layout.disc[i];
      if (c.x < x0) x0 = c.x;
      if (c.x > x1) x1 = c.x;
      if (c.y < y0) y0 = c.y;
      if (c.y > y1) y1 = c.y;
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /**
   * Where the code sits in the picture: the extent of the dark pixels. A
   * screenshot has no transparency to lean on, and the disc's edge is ragged,
   * so this is a guess to within about a module - which the Reed-Solomon
   * decoder then sorts out.
   */
  function imageBox(data, width, height) {
    var x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var p = (y * width + x) * 4;
        var lum = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
        if (lum < 128) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < x0 || y1 < y0) return null;
    return { x0: x0, y0: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** Sample the grid of a custom layout out of a picture. */
  function sampleDisc(lay, data, width, height, box, s, dx, dy) {
    var G = lay.G;
    var ox = box.x0 + box.w / 2 + dx - ((G - 1) / 2) * s;
    var oy = box.y0 + box.h / 2 + dy - ((G - 1) / 2) * s;
    var mods = new Uint8Array(G * G);
    for (var y = 0; y < G; y++) {
      for (var x = 0; x < G; x++) {
        var px = Math.round(ox + x * s);
        var py = Math.round(oy + y * s);
        // the grid reaches past the picture at the corners; those cells are
        // not part of the disc, so they are simply left light
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        var p = (py * width + px) * 4;
        var lum = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
        mods[y * G + x] = lum < 128 ? 1 : 0;
      }
    }
    return mods;
  }

  /**
   * How many of the finder pattern's cells a sample gets wrong. It is a
   * measure, not a verdict: a styled render draws the eyes differently, and a
   * half-module drift shifts the sample, so a few cells out is normal — the
   * Reed-Solomon decoder sorts those out. A wrong version misses most of
   * them, which is what tells the versions apart.
   *
   * Only the solid core of the eye is looked at: the centre and the four cells
   * around it are dark in every style, whatever shape the eye itself takes.
   */
  function finderCells() {
    var cells = [{ dx: 0, dy: 0, want: 1 }];
    var ring = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var g = 0; g < ring.length; g++) cells.push({ dx: ring[g][0], dy: ring[g][1], want: 1 });
    return cells;
  }
  var FINDER_CELLS = finderCells();

  function finderMismatch(lay, mods) {
    var G = lay.G;
    var bad = 0;
    for (var f = 0; f < lay.finders.length; f++) {
      var fx = lay.finders[f].x, fy = lay.finders[f].y;
      for (var c = 0; c < FINDER_CELLS.length; c++) {
        var cell = FINDER_CELLS[c];
        if (mods[(fy + cell.dy) * G + (fx + cell.dx)] !== cell.want) bad++;
      }
    }
    return bad;
  }

  /**
   * The same measure, but sampling only the eyes — a few dozen pixels
   * instead of the whole grid, so the search can be wide.
   */
  function finderMismatchAt(lay, data, width, height, box, s, dx, dy) {
    var G = lay.G;
    var ox = box.x0 + box.w / 2 + dx - ((G - 1) / 2) * s;
    var oy = box.y0 + box.h / 2 + dy - ((G - 1) / 2) * s;
    var bad = 0;
    for (var f = 0; f < lay.finders.length; f++) {
      var fx = lay.finders[f].x, fy = lay.finders[f].y;
      for (var c = 0; c < FINDER_CELLS.length; c++) {
        var cell = FINDER_CELLS[c];
        var px = Math.round(ox + (fx + cell.dx) * s);
        var py = Math.round(oy + (fy + cell.dy) * s);
        if (px < 0 || py < 0 || px >= width || py >= height) { bad++; continue; }
        var p = (py * width + px) * 4;
        var lum = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
        if ((lum < 128 ? 1 : 0) !== cell.want) bad++;
      }
    }
    return bad;
  }

  /** The share of the eye cells a sample has to get right. */
  var FINDER_TOLERANCE = 0.2;

  /**
   * Read one of our custom codes out of a picture. The version is not
   * written anywhere, so each is tried: the layout fixes the grid, the
   * picture's shape fixes the scale, and the modules are sampled at the
   * cell centres.
   */
  function readCustom(data, width, height, opts) {
    opts = opts || {};
    var box = imageBox(data, width, height);
    if (!box) return null;
    for (var v = MIN_VERSION; v <= MAX_VERSION; v++) {
      var lay = customLayout(v);
      var s0 = (box.w / 2) / lay.rDisc;
      if (s0 < 1) continue;
      // the disc's edge is ragged, so the extent is a rough measure: the scale
      // is searched around it, and the eyes say when it is right
      for (var t = -15; t <= 15; t++) {
        var s = s0 * (1 + t * 0.02);
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            // the offset is in modules, and a module is s pixels
            var mx = dx * 0.5 * s, my = dy * 0.5 * s;
            // the eyes first: a hundred and forty-odd pixels against the
            // whole grid, and they say whether this version, scale and
            // position are right
            if (finderMismatchAt(lay, data, width, height, box, s, mx, my) > FINDER_CELLS.length * FINDER_TOLERANCE) continue;
            var mods = sampleDisc(lay, data, width, height, box, s, mx, my);
            if (!mods) continue;
            // the format block says which mask this is, so the read is one try
            // instead of eight. Its own fit is near the eye, so it is used for
            // the mask alone: the data is sampled where the search found it,
            // and Reed-Solomon sorts out the drift.
            var fine = readFormatNear(lay, data, width, height, box, s, mx, my);
            var masks = fine ? [fine.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
            for (var mi = 0; mi < masks.length; mi++) {
              var url = decodeCustom(mods, lay, masks[mi]);
              if (url) {
                return { url: url, version: v, layout: lay, scale: s, mask: masks[mi], format: !!fine };
              }
            }
          }
        }
      }
    }
    return null;
  }

  /**
   * Read a code out of a picture: a standard one with jsQR, one of ours
   * with the custom layout.
   */
  function readImage(data, width, height, decoder) {
    // a standard QR, if a decoder was handed over
    var dec = decoder || jsQR;
    if (dec) {
      var res = dec(data, width, height, { inversionAttempts: 'attemptBoth' });
      if (res && res.data) return { url: res.data, kind: 'standard' };
    }
    var ours = readCustom(data, width, height);
    if (ours) {
      return {
        url: ours.url, kind: 'custom', version: ours.version, layout: ours.layout,
        scale: ours.scale, mask: ours.mask, format: ours.format
      };
    }
    return null;
  }

  return {
    readImage: readImage,
    readCustom: readCustom,
    decodeCustom: decodeCustom,
    rsDecode: rsDecode,
    maskAt: maskAt,
    customLayout: customLayout,
    discCells: discCells,
    formatCells: formatCells,
    formatBits: formatBits,
    readFormat: readFormat
  };
});
