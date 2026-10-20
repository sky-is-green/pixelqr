/**
 * PixelQR app — pixel art ⇄ QR editor.
 * Core engine: core.js (PixelQR). Decoder: lib/jsQR.js. Encoder: lib/qrcode.js.
 *
 * Two pipelines (core.js):
 *   standard — an ordinary QR code. Any phone camera reads it. The free
 *              surface (the area you may paint, kept free of random code
 *              cells) comes in three shapes and is sized by the error budget.
 *   custom   — my own layout: a circular grid with the finder patterns inside
 *              it, so the code fills a round avatar edge to edge. It decodes
 *              with the engine's own decoder, not with a phone camera.
 */
(function () {
  'use strict';

  var P = window.PixelQR;
  var BASE_CELL = 16;     // editor cell size at 1x (px)
  var PREVIEW_BOX = 12;   // preview module size (px)
  var ZOOMS = [0.5, 1, 2, 3, 4];   // half is the overview: the whole grid at once

  // The versions on offer, per generation. The standard one keeps to the
  // versions that have no alignment pattern in the drawing area (v3 to v6),
  // plus v12 — the one that buys the biggest surface for a big drawing. A
  // cross is thinner still: its arms only have room to draw in at v12. The
  // custom layout has no alignment patterns at all, so every version is fair
  // game there.
  var STANDARD_VERSIONS = [3, 4, 5, 6, 12];
  var CROSS_VERSIONS = [12];
  var CUSTOM_VERSIONS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

  function versionsFor(pipeline, surface) {
    if (pipeline === 'custom') return CUSTOM_VERSIONS;
    if (surface === 'cross') return CROSS_VERSIONS;
    return STANDARD_VERSIONS;
  }

  var state = {
    pipeline: 'standard',                    // standard | custom
    version: 6,                              // default: the biggest canvas, most room to draw
    mask: 'auto',
    brush: 1,                                // 1 = ink, 0 = erase
    style: 'dots',                           // render style: square | rounded | dots
    surface: 'squircle',                     // the shape of the free area
    zoom: 1,                                 // the editor's zoom: bigger cells, finer detail
    url: 'https://USER.github.io',
    artRows: null,                           // set on boot, once the grid size is known
    result: null,
    error: null
  };
  var labeledUrl = null; // which url the version labels reflect
  var labelKey = null;   // url + pipeline + surface the labels reflect

  var undoStack = [];

  // ---------------- helpers ----------------

  function $(sel) { return document.querySelector(sel); }
  function pipe() { return P.PIPELINES[state.pipeline] || P.PIPELINES.standard; }

  /** The editor's cell size: the base cell, scaled by the zoom. */
  function cell() { return BASE_CELL * state.zoom; }

  /** The zoom readout, and the buttons' ends. */
  function zoomLabel() {
    var z = state.zoom;
    $('#zoom-level').textContent = (z === 0.5 ? '½' : String(z)) + '×';
    $('#zoom-out').disabled = z <= ZOOMS[0];
    $('#zoom-in').disabled = z >= ZOOMS[ZOOMS.length - 1];
  }

  /** The editor grid: a square for the standard pipeline, a disc's box for mine. */
  function n() {
    return pipe().grid(state.url, state.version);
  }

  /** The finder patterns of the current pipeline (for the styled renders). */
  function findersOf(result) {
    if (result && result.base && result.base.layout) {
      var lay = result.base.layout, out = [];
      for (var i = 0; i < lay.finders.length; i++) {
        out.push({ x: lay.finders[i].x - 3, y: lay.finders[i].y - 3 });
      }
      return out;
    }
    return null;
  }

  function pushUndo() {
    undoStack.push(state.artRows.slice());
    if (undoStack.length > 80) undoStack.shift();
  }

  function undo() {
    if (!undoStack.length) return;
    state.artRows = undoStack.pop();
    refresh(true);
  }

  /**
   * Version changes reframe the art instead of stretching it: the drawing keeps
   * its module size and stays centred (padded with light on bigger versions,
   * cropped on smaller ones). Stretching would distort the drawing, and a
   * stretch round-trip scrambles cells.
   */
  function reframeRows(rows, newN) {
    var oldN = rows.length;
    var off = Math.floor((newN - oldN) / 2);
    var out = [];
    for (var y = 0; y < newN; y++) {
      var row = '';
      for (var x = 0; x < newN; x++) {
        var oy = y - off, ox = x - off;
        row += (oy >= 0 && ox >= 0 && oy < oldN && ox < oldN) ? rows[oy][ox] : '.';
      }
      out.push(row);
    }
    return out;
  }

  function setRows(rows) {
    pushUndo();
    state.artRows = reframeRows(rows, n());
    refresh(true);
  }

  /** Bounding box of the ink in template rows ({w, h} of the '#' area). */
  function artBBox(rows) {
    var x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (var y = 0; y < rows.length; y++) {
      for (var x = 0; x < rows.length; x++) {
        if (rows[y][x] === '#') {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return { w: 0, h: 0 };
    return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /**
   * The version list for the current generation. A version that could never
   * hold the link is greyed out rather than left to fail later.
   */
  function buildVersionList() {
    var sel = $('#version');
    var list = versionsFor(state.pipeline, state.surface);
    sel.innerHTML = '';
    list.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = String(v);
      sel.appendChild(opt);
    });
    // keep the version if this generation still has it, else the nearest one
    if (list.indexOf(state.version) < 0) {
      var best = list[0], gap = 1e9;
      list.forEach(function (v) {
        var d = Math.abs(v - state.version);
        if (d < gap) { gap = d; best = v; }
      });
      state.version = best;
    }
    sel.value = String(state.version);
  }

  /**
   * Version labels: the grid each version would use, the surface it would
   * give, and whether it could hold this link at all.
   */
  function updateVersionLabels() {
    var custom = state.pipeline === 'custom';
    var min = P.minVersion(state.url, {
      surface: custom ? 'circle' : state.surface,
      pipeline: custom ? 'custom' : 'standard'
    });
    Array.prototype.forEach.call($('#version').options, function (opt) {
      var v = parseInt(opt.value, 10);
      var grid = custom ? P.PIPELINES.custom.grid(state.url, v) : (v * 4 + 17);
      if (v < min) {
        opt.disabled = true;
        opt.textContent = 'v' + v + ' · too small for this link';
        return;
      }
      opt.disabled = false;
      var sh = P.canvasShape(state.url, v, { surface: custom ? 'circle' : state.surface });
      opt.textContent = 'v' + v + ' · ' + grid + '×' + grid +
        ' · free ~' + sh.width + '×' + sh.width;
    });
    state.minVersion = min;
  }

  /**
   * The note under the tools: what the current mode and version mean.
   */
  function updateHint() {
    var hint = $('#pipeline-hint');
    if (state.pipeline === 'custom') {
      hint.textContent = P.PIPELINES.custom.hint +
        ' No alignment patterns, no timing pattern: the whole disc is yours to draw in.';
      return;
    }
    var bits = ['The ordinary QR code. Any phone camera reads it.'];
    if (state.version >= 7) {
      bits.push('From v7 on there are alignment patterns, and one sits in the middle of ' +
        'the drawing area: the code needs it to find its own geometry, so it stays blank ' +
        '(the custom mode has none).');
    }
    if (state.surface === 'cross') {
      bits.push('A cross is thin: its arms only have room to draw in at v12, ' +
        'so that is the only version on offer.');
    }
    hint.textContent = bits.join(' ');
  }

  /**
   * Draw a module matrix. Styles mirror core.renderRGBA:
   * square (crisp), rounded (soft tiles), dots — styled variants redraw the
   * three finders as rounded rings. The editor panel keeps plain squares.
   */
  function drawMatrix(ctx, modules, size, box, border, offX, offY, style, finders, mask, bg) {
    style = style || 'square';
    ctx.fillStyle = bg || 'white';
    ctx.fillRect(offX, offY, (size + 2 * border) * box, (size + 2 * border) * box);
    if (mask) {
      // the code is a disc: paint it white so the modules read on it
      ctx.fillStyle = 'white';
      for (var my = 0; my < size; my++) {
        for (var mx = 0; mx < size; mx++) {
          if (!mask[my * size + mx]) continue;
          ctx.fillRect(offX + (mx + border) * box, offY + (my + border) * box, box, box);
        }
      }
    }
    ctx.fillStyle = 'black';
    if (style === 'square') {
      for (var y0 = 0; y0 < size; y0++) {
        for (var x0 = 0; x0 < size; x0++) {
          if (mask && !mask[y0 * size + x0]) continue;
          if (modules[y0 * size + x0]) {
            ctx.fillRect(offX + (x0 + border) * box, offY + (y0 + border) * box, box, box);
          }
        }
      }
      return;
    }
    var zones = finders || [{ x: 0, y: 0 }, { x: size - 7, y: 0 }, { x: 0, y: size - 7 }];
    var inFinder = function (x, y) {
      for (var fi = 0; fi < zones.length; fi++) {
        var f = zones[fi];
        if (x >= f.x && x < f.x + 7 && y >= f.y && y < f.y + 7) return true;
      }
      return false;
    };
    var canRound = typeof ctx.roundRect === 'function';
    if (!canRound && style === 'rounded') style = 'dots'; // unknown/legacy fallback only
    var hexPath = function (cx, cy, R) { // R = circumradius (vertex distance)
      for (var k = 0; k < 6; k++) {
        var a = k * Math.PI / 3;
        var vx = cx + R * Math.cos(a), vy = cy + R * Math.sin(a);
        if (k === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
      }
      ctx.closePath();
    };
    var hexEyePath = function (cx, cy, r) {
      // stretched hexagon: vertices at (±r, 0), flats at (±r/2, ±r)
      ctx.moveTo(cx + r, cy);
      ctx.lineTo(cx + r / 2, cy - r);
      ctx.lineTo(cx - r / 2, cy - r);
      ctx.lineTo(cx - r, cy);
      ctx.lineTo(cx - r / 2, cy + r);
      ctx.lineTo(cx + r / 2, cy + r);
      ctx.closePath();
    };
    var leafPath = function (cx, cy, h, r) {
      ctx.moveTo(cx - h, cy - h + r);
      ctx.arcTo(cx - h, cy - h, cx - h + r, cy - h, r);
      ctx.lineTo(cx + h, cy - h);
      ctx.lineTo(cx + h, cy + h - r);
      ctx.arcTo(cx + h, cy + h, cx + h - r, cy + h, r);
      ctx.lineTo(cx - h, cy + h);
      ctx.closePath();
    };
    var diamondPath = function (cx, cy, r) {
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
    };
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (mask && !mask[y * size + x]) continue;
        if (!modules[y * size + x] || inFinder(x, y)) continue;
        var px = offX + (x + border) * box, py = offY + (y + border) * box;
        var cx2 = px + box / 2, cy2 = py + box / 2;
        ctx.beginPath();
        if (style === 'dots') {
          ctx.arc(cx2, cy2, box * 0.5, 0, Math.PI * 2);
        } else if (style === 'diamond') {
          diamondPath(cx2, cy2, box * 0.7);
        } else if (style === 'hexagon') {
          hexPath(cx2, cy2, box * 0.55);
        } else if (style === 'squircle') {
          var sr = box * 0.55;
          for (var k3 = 0; k3 <= 24; k3++) {
            var th3 = k3 / 24 * Math.PI * 2;
            var c3 = Math.cos(th3), s3 = Math.sin(th3);
            var rad3 = sr / Math.pow(Math.pow(Math.abs(c3), 4) + Math.pow(Math.abs(s3), 4), 0.25);
            var sx3 = cx2 + rad3 * c3, sy3 = cy2 + rad3 * s3;
            if (k3 === 0) ctx.moveTo(sx3, sy3); else ctx.lineTo(sx3, sy3);
          }
          ctx.closePath();
        } else if (style === 'leaf') {
          leafPath(cx2, cy2, box * 0.53, box * 0.48);
        } else {
          var o = box * 0.03;
          ctx.roundRect(px - o, py - o, box + 2 * o, box + 2 * o, box * 0.32);
        }
        ctx.fill();
      }
    }
    for (var f = 0; f < zones.length; f++) {
      var zx = offX + (zones[f].x + border) * box, zy = offY + (zones[f].y + border) * box;
      ctx.fillStyle = 'white';
      ctx.fillRect(zx, zy, 7 * box, 7 * box);
      ctx.fillStyle = 'black';
      // clip to the finder zone (like the raster engine, so pointed rings
      // never pollute the separator)
      ctx.save();
      ctx.beginPath();
      ctx.rect(zx, zy, 7 * box, 7 * box);
      ctx.clip();
      var cx = zx + 3.5 * box, cy = zy + 3.5 * box;
      ctx.lineWidth = box;
      ctx.strokeStyle = 'black';
      ctx.beginPath();
      var ringEvenOdd = false;
      if (style === 'dots') {
        ctx.arc(cx, cy, 3 * box, 0, Math.PI * 2);
      } else if (style === 'hexagon') {
        hexEyePath(cx, cy, 3.5 * box);
        hexEyePath(cx, cy, 2.5 * box);
        ringEvenOdd = true;
      } else if (style === 'diamond') {
        diamondPath(cx, cy, 3.5 * box);
        diamondPath(cx, cy, 2.5 * box);
        ringEvenOdd = true;
      } else if (style === 'leaf') {
        leafPath(cx, cy, 3 * box, 2.72 * box);
      } else {
        ctx.roundRect(cx - 3 * box, cy - 3 * box, 6 * box, 6 * box, box * 1.7);
      }
      if (ringEvenOdd) ctx.fill('evenodd'); else ctx.stroke();
      ctx.beginPath();
      if (style === 'dots') {
        ctx.arc(cx, cy, 1.5 * box, 0, Math.PI * 2);
      } else if (style === 'hexagon') {
        hexEyePath(cx, cy, 1.5 * box);
      } else if (style === 'diamond') {
        diamondPath(cx, cy, 1.5 * box);
      } else if (style === 'leaf') {
        leafPath(cx, cy, 1.5 * box, 1.36 * box);
      } else {
        ctx.roundRect(cx - 1.5 * box, cy - 1.5 * box, 3 * box, 3 * box, box * 0.75);
      }
      ctx.fill();
      ctx.restore();
    }
  }

  // ---------------- recompute ----------------

  var pending = null;
  function refresh(immediate) {
    if (pending) clearTimeout(pending);
    if (immediate) { recompute(); return; }
    pending = setTimeout(recompute, 60);
  }

  function recompute() {
    pending = null;
    state.error = null;
    try {
      var art = P.artFromRows(state.artRows);
      var prev = state.result;
      var sameCode = prev && prev.url === state.url && prev.version === state.version &&
        prev.maskChoice === state.mask && prev.pipeline === state.pipeline &&
        prev.surface === state.surface;
      var w = pipe().fit(state.url, state.version, art, {
        mask: state.mask === 'auto' ? 'auto' : state.mask,
        style: state.style,
        margin: 1.0,
        surface: state.surface,
        // strokes re-use the established encoding + surface (fast, stable while painting)
        reuse: sameCode ? { mask: prev.mask, suffix: prev.suffix } : null,
        canvasR: sameCode ? prev.canvas.R : undefined
      });
      state.result = {
        base: w.fit.base, t: w.t, mask: w.fit.mask, suffix: w.fit.suffix,
        pad: w.fit.pad || null, canvas: w.canvas, residual: w.residual,
        url: state.url, version: state.version, maskChoice: state.mask,
        pipeline: state.pipeline, surface: state.surface
      };
    } catch (e) {
      state.result = null;
      state.error = (typeof e === 'string') ? e : (e && e.message) || 'QR build failed';
    }
    if (labelKey !== state.url + '|' + state.pipeline + '|' + state.surface) {
      try { updateVersionLabels(); } catch (e) { /* the labels are a nicety */ }
      labelKey = state.url + '|' + state.pipeline + '|' + state.surface;
    }
    try { drawEditor(); } catch (e) { /* keep the rest alive */ }
    try { drawPreview(); } catch (e) { /* keep the rest alive */ }
    try { updateStatus(); } catch (e) { /* keep the rest alive */ }
  }

  // ---------------- editor ----------------

  /** Is this cell inside the free surface? */
  function inSurface(result, x, y, size) {
    if (!result || !result.canvas) return true;
    return P.surfaceHas(result.canvas.kind, result.canvas.R, x, y, size);
  }

  /** Is this cell part of the code at all? (the custom layout is a disc) */
  function inCode(result, x, y, size) {
    if (!result || !result.base || !result.base.layout) return true;
    var lay = result.base.layout;
    return !!lay.inDisc[y * size + x];
  }

  function drawEditor() {
    var canvasEl = $('#editor');
    var size = n();
    var CELL = cell();
    canvasEl.width = canvasEl.height = size * CELL + 1;
    var ctx = canvasEl.getContext('2d');
    ctx.fillStyle = '#14141b';
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

    var result = state.result;
    var func = result && result.base ? result.base.func : P.buildFunctionMask(state.version);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var i = y * size + x;
        var px = x * CELL, py = y * CELL;
        var ch = state.artRows[y][x];
        if (!inCode(result, x, y, size)) continue; // outside the disc
        var outside = !inSurface(result, x, y, size);
        if (func[i]) {
          if (result) {
            // Fixed QR skeleton (finders, timing, alignment, format cells).
            // Shown in its true final colour so the canvas reads as one image;
            // the faint diagonal is the only hint that it can't be painted.
            ctx.fillStyle = result.t.modules[i] ? '#000' : '#fff';
            ctx.fillRect(px, py, CELL, CELL);
            ctx.strokeStyle = result.t.modules[i] ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)';
            ctx.beginPath();
            ctx.moveTo(px + 2, py + CELL - 2);
            ctx.lineTo(px + CELL - 2, py + 2);
            ctx.stroke();
          } else {
            ctx.fillStyle = '#2b2b38';
            ctx.fillRect(px, py, CELL, CELL);
            ctx.strokeStyle = '#3d3d4f';
            ctx.beginPath();
            ctx.moveTo(px, py + CELL);
            ctx.lineTo(px + CELL, py);
            ctx.stroke();
          }
        } else if (outside && ch !== '#') {
          // The code ring — where the QR's own randomness lives. Shown in its
          // final colours with the same diagonal: it's code, not canvas.
          if (result) {
            var on = result.t.modules[i];
            ctx.fillStyle = on ? '#000' : '#fff';
            ctx.fillRect(px, py, CELL, CELL);
            ctx.strokeStyle = on ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)';
            ctx.beginPath();
            ctx.moveTo(px + 2, py + CELL - 2);
            ctx.lineTo(px + CELL - 2, py + 2);
            ctx.stroke();
          } else {
            ctx.fillStyle = '#1d1d27';
            ctx.fillRect(px, py, CELL, CELL);
            ctx.strokeStyle = '#33333f';
            ctx.beginPath();
            ctx.moveTo(px, py + CELL);
            ctx.lineTo(px + CELL, py);
            ctx.stroke();
          }
        } else {
          // Writable surface. (Leftover ink that ended up outside after a
          // version/surface change is shown too — red-dotted, ready to erase.)
          ctx.fillStyle = ch === '#' ? '#000' : '#fff';
          ctx.fillRect(px, py, CELL, CELL);
          if (ch === '#' && result && (!result.t.modules[i] || outside)) {
            ctx.fillStyle = 'rgba(255, 70, 70, 0.95)';
            ctx.beginPath();
            ctx.arc(px + CELL - 4, py + CELL - 4, 2.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    for (var g = 0; g <= size; g++) {
      ctx.moveTo(g * CELL + 0.5, 0); ctx.lineTo(g * CELL + 0.5, size * CELL);
      ctx.moveTo(0, g * CELL + 0.5); ctx.lineTo(size * CELL, g * CELL + 0.5);
    }
    ctx.stroke();
    // the surface boundary (drawn along the cell edges between the surface
    // and the code ring)
    if (result && result.canvas) {
      var kind = result.canvas.kind, R = result.canvas.R;
      ctx.strokeStyle = 'rgba(106, 166, 255, 0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (var yy = 0; yy < size; yy++) {
        for (var xx = 0; xx < size; xx++) {
          if (!P.surfaceHas(kind, R, xx, yy, size)) continue;
          if (yy === 0 || !P.surfaceHas(kind, R, xx, yy - 1, size)) {
            ctx.moveTo(xx * CELL, yy * CELL + 1.5); ctx.lineTo((xx + 1) * CELL, yy * CELL + 1.5);
          }
          if (yy === size - 1 || !P.surfaceHas(kind, R, xx, yy + 1, size)) {
            ctx.moveTo(xx * CELL, (yy + 1) * CELL - 1.5); ctx.lineTo((xx + 1) * CELL, (yy + 1) * CELL - 1.5);
          }
          if (xx === 0 || !P.surfaceHas(kind, R, xx - 1, yy, size)) {
            ctx.moveTo(xx * CELL + 1.5, yy * CELL); ctx.lineTo(xx * CELL + 1.5, (yy + 1) * CELL);
          }
          if (xx === size - 1 || !P.surfaceHas(kind, R, xx + 1, yy, size)) {
            ctx.moveTo((xx + 1) * CELL - 1.5, yy * CELL); ctx.lineTo((xx + 1) * CELL - 1.5, (yy + 1) * CELL);
          }
        }
      }
      // The alignment patterns are holes in that surface: from v7 on one sits
      // exactly in the middle, and the code needs it, so it cannot be drawn
      // on. Mark its edges the same way, so the drawing area reads true.
      if (state.pipeline === 'standard') {
        var pats = P.alignmentPatterns(state.version);
        for (var pi = 0; pi < pats.length; pi++) {
          var cx2 = pats[pi].x + 2, cy2 = pats[pi].y + 2;
          if (!P.surfaceHas(kind, R, cx2, cy2, size)) continue;
          ctx.rect(pats[pi].x * CELL + 1.5, pats[pi].y * CELL + 1.5, 5 * CELL - 3, 5 * CELL - 3);
        }
      }
      ctx.stroke();
    }
  }

  function cellFromEvent(evt) {
    var rect = $('#editor').getBoundingClientRect();
    var CELL = cell();
    var scale = (n() * CELL + 1) / rect.width;
    var x = Math.floor(((evt.clientX - rect.left) * scale) / CELL);
    var y = Math.floor(((evt.clientY - rect.top) * scale) / CELL);
    if (x < 0 || y < 0 || x >= n() || y >= n()) return null;
    return { x: x, y: y };
  }

  var painting = false;
  function applyBrush(evt, forced) {
    var c = cellFromEvent(evt);
    if (!c) return;
    var size = n();
    var res = state.result;
    var func = res && res.base ? res.base.func : P.buildFunctionMask(state.version);
    if (func[c.y * size + c.x]) return; // locked skeleton
    if (!inCode(res, c.x, c.y, size)) return; // outside the disc
    var ch = forced !== undefined ? forced : (state.brush === 1 ? '#' : '.');
    if (ch === '#' && !inSurface(res, c.x, c.y, size)) {
      return; // the free surface is the design area — the ring stays code
    }
    var row = state.artRows[c.y];
    if (row[c.x] !== ch) {
      state.artRows[c.y] = row.substring(0, c.x) + ch + row.substring(c.x + 1);
      refresh();
    }
  }

  function wireEditor() {
    var canvas = $('#editor');
    canvas.addEventListener('pointerdown', function (e) {
      if (e.button === 2) return;
      pushUndo();
      painting = true;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
      applyBrush(e);
    });
    canvas.addEventListener('pointermove', function (e) { if (painting) applyBrush(e); });
    canvas.addEventListener('pointerup', function () { painting = false; });
    canvas.addEventListener('pointercancel', function () { painting = false; });
    canvas.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      pushUndo();
      applyBrush(e, '.'); // right-click erases
    });
  }

  // ---------------- preview + status ----------------

  function drawPreview() {
    var canvas = $('#preview');
    var size = n();
    canvas.width = canvas.height = (size + 8) * PREVIEW_BOX;
    var ctx = canvas.getContext('2d');
    if (state.error || !state.result) {
      ctx.fillStyle = '#14141b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    // the custom layout is a disc: the cells outside it are not code, so the
    // preview shows the round shape on the panel, not a white square
    var custom = state.pipeline === 'custom';
    drawMatrix(ctx, state.result.t.modules, size, PREVIEW_BOX, 4, 0, 0, state.style,
      findersOf(state.result), custom ? discMask() : null, custom ? '#14141b' : 'white');
  }

  /** The cells that are part of the code (the custom layout is a disc). */
  function discMask() {
    var res = state.result;
    if (!res || !res.base || !res.base.layout) return null;
    return res.base.layout.inDisc;
  }

  function updateStatus() {
    var badge = $('#badge');
    var detail = $('#badge-detail');
    badge.className = 'badge';
    if (state.error) {
      badge.classList.add('bad');
      badge.textContent = '✗ ' + state.error;
      detail.textContent = 'Try a shorter URL or a higher QR version.';
      return;
    }
    var t = state.result.t;
    var base = state.result.base;
    var res = state.result.residual || { bg: 0, ink: 0 };
    var can = state.result.canvas;
    var custom = state.pipeline === 'custom';
    if (t.verified) {
      badge.classList.add('ok');
      badge.textContent = t.iterations > 1
        ? '✓ Decodes (auto-tuned)'
        : (custom ? '✓ Decodes: clean' : '✓ Scannable: clean & at distance');
      var parts = [
        'surface ' + can.width + '×' + can.width +
          (res.bg === 0 ? ' · zero random cells inside' : ' · ' + res.bg + ' stray cells left'),
        res.ink === 0 ? 'all ink realized' : res.ink + ' ink cells unrealized',
        t.cwUsed + '/' + t.cwBudget + ' codewords sacrificed'
      ];
      if (state.result.suffix) parts.push('pattern-fit ' + state.result.suffix + ' added to link');
      if (state.result.pad && state.result.pad.fixed > 0) {
        parts.push(state.result.pad.fixed + ' cells fixed by free payload bits');
      }
      parts.push(custom
        ? "decoded by the engine's own Reed-Solomon decoder"
        : 'decode-verified at 296px + 148px blurred, as rendered');
      detail.textContent = parts.join(' · ');
    } else {
      badge.classList.add('bad');
      badge.textContent = '✗ Not decodable with this art';
      detail.textContent = 'Too many conflicting paints: erase some strokes or switch to a higher version (bigger surface).';
    }
    $('#stats').textContent = 'v' + base.version + ' · ' + n() + '×' + n() + ' modules · mask ' +
      state.result.mask + ' · ' + state.style + ' style · ' + can.kind + ' surface · ' +
      can.width + '×' + can.width + ' free · ' + base.drawable + ' drawable cells';
  }

  // ---------------- exports ----------------

  function download(canvasOrBlob, name) {
    var a = document.createElement('a');
    a.download = name;
    if (canvasOrBlob.toBlob) {
      canvasOrBlob.toBlob(function (b) { a.href = URL.createObjectURL(b); a.click(); });
    } else {
      a.href = URL.createObjectURL(canvasOrBlob);
      a.click();
    }
  }

  function qrCanvas(box) {
    var size = n();
    var c = document.createElement('canvas');
    c.width = c.height = (size + 8) * box;
    var custom = state.pipeline === 'custom';
    drawMatrix(c.getContext('2d'), state.result.t.modules, size, box, 4, 0, 0, state.style,
      findersOf(state.result), custom ? discMask() : null, custom ? '#ffffff' : 'white');
    return c;
  }

  /**
   * The round avatar: the code inside a circle, with the finder patterns
   * clear of the rim. Standard — the QR square is inscribed in the circle.
   * Custom — the disc fills it edge to edge.
   */
  function avatarCanvas(sizePx) {
    var c = document.createElement('canvas');
    c.width = c.height = sizePx;
    var ctx = c.getContext('2d');
    var res = state.result;
    var img;
    if (state.pipeline === 'custom') {
      img = P.renderDiscRGBA(res.t.modules, res.base.n, res.base.layout, sizePx, state.style);
    } else {
      // the largest module size that still decodes after the circular crop
      var box = P.roundAvatarBox(res.t.modules, res.base.n, sizePx, state.style, {
        url: res.base.url, finders: findersOf(res)
      });
      img = P.renderRoundRGBA(res.t.modules, res.base.n, sizePx, state.style, {
        box: box, finders: findersOf(res)
      });
    }
    var out = ctx.createImageData(sizePx, sizePx);
    out.data.set(img.data);
    ctx.putImageData(out, 0, 0);
    return c;
  }

  function wireControls() {
    $('#url').addEventListener('input', function () {
      state.url = this.value || 'https://USER.github.io';
      refresh();
    });
    // When the link is committed, make sure the version can still hold it:
    // a link that grew past the version's capacity is a dead error, so the
    // version follows the link up to the smallest that fits — among the ones
    // this generation offers.
    $('#url').addEventListener('change', function () {
      state.url = this.value || 'https://USER.github.io';
      var min = P.minVersion(state.url, {
        surface: state.pipeline === 'custom' ? 'circle' : state.surface,
        pipeline: state.pipeline
      });
      if (state.version < min) {
        var list = versionsFor(state.pipeline, state.surface);
        var pick = null;
        list.forEach(function (v) { if (v >= min && (pick === null || v < pick)) pick = v; });
        if (pick === null) pick = list[list.length - 1];
        state.version = pick;
        $('#version').value = String(pick);
        state.artRows = reframeRows(state.artRows, n());
      }
      refresh(true);
    });

    $('#version').addEventListener('change', function () {
      state.version = parseInt(this.value, 10);
      state.artRows = reframeRows(state.artRows, n());
      updateHint();
      refresh(true);
    });

    $('#mask').addEventListener('change', function () {
      state.mask = this.value === 'auto' ? 'auto' : parseInt(this.value, 10);
      refresh(true);
    });
    $('#shuffle-mask').addEventListener('click', function () {
      var m = Math.floor(Math.random() * 8);
      $('#mask').value = String(m);
      state.mask = m;
      refresh(true);
    });

    // The zoom: bigger cells for finer detail. The grid is redrawn at the
    // new cell size (so it stays crisp) and the frame scrolls when it
    // outgrows the panel — keeping the same cell in the middle, so zooming
    // in does not throw away what you were looking at.
    function setZoom(z) {
      var next = Math.min(Math.max(ZOOMS[0], z), ZOOMS[ZOOMS.length - 1]);
      if (next === state.zoom) return;
      var frame = $('.editor-frame');
      var canvas = $('#editor');
      var before = null;
      if (frame && canvas) {
        var fr = frame.getBoundingClientRect();
        var cr = canvas.getBoundingClientRect();
        if (cr.width && fr.width) {
          before = {
            x: (fr.left + fr.width / 2 - cr.left) / cr.width,
            y: (fr.top + fr.height / 2 - cr.top) / cr.height
          };
        }
      }
      state.zoom = next;
      zoomLabel();
      drawEditor();
      if (before && frame && canvas) {
        var fr2 = frame.getBoundingClientRect();
        var cr2 = canvas.getBoundingClientRect();
        frame.scrollLeft += (cr2.left + before.x * cr2.width) - (fr2.left + fr2.width / 2);
        frame.scrollTop += (cr2.top + before.y * cr2.height) - (fr2.top + fr2.height / 2);
      }
    }

    function stepZoom(dir) {
      var i = ZOOMS.indexOf(state.zoom);
      if (i < 0) i = 1;
      setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + dir))]);
    }

    $('#zoom-in').addEventListener('click', function () { stepZoom(1); });
    $('#zoom-out').addEventListener('click', function () { stepZoom(-1); });
    // ctrl+wheel zooms too, for a mouse that is already there
    $('#editor').addEventListener('wheel', function (e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      stepZoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    Array.prototype.forEach.call(document.querySelectorAll('[data-brush]'), function (btn) {
      btn.addEventListener('click', function () {
        state.brush = parseInt(btn.getAttribute('data-brush'), 10);
        Array.prototype.forEach.call(document.querySelectorAll('[data-brush]'), function (b) {
          b.classList.toggle('active', b === btn);
        });
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-style]'), function (btn) {
      btn.addEventListener('click', function () {
        state.style = btn.getAttribute('data-style');
        Array.prototype.forEach.call(document.querySelectorAll('[data-style]'), function (b) {
          b.classList.toggle('active', b === btn);
        });
        refresh(true); // re-verify: the styled render is what gets decoded
      });
    });

    // The generation: standard QR, or my own circular layout.
    Array.prototype.forEach.call(document.querySelectorAll('[data-pipeline]'), function (btn) {
      btn.addEventListener('click', function () {
        state.pipeline = btn.getAttribute('data-pipeline');
        Array.prototype.forEach.call(document.querySelectorAll('[data-pipeline]'), function (b) {
          b.classList.toggle('active', b === btn);
        });
        $('#surface-group').classList.toggle('hidden', state.pipeline === 'custom');
        buildVersionList();
        updateVersionLabels();
        updateHint();
        state.artRows = reframeRows(state.artRows, n());
        refresh(true);
      });
    });

    // The shape of the free surface (standard pipeline only).
    Array.prototype.forEach.call(document.querySelectorAll('[data-surface]'), function (btn) {
      btn.addEventListener('click', function () {
        state.surface = btn.getAttribute('data-surface');
        Array.prototype.forEach.call(document.querySelectorAll('[data-surface]'), function (b) {
          b.classList.toggle('active', b === btn);
        });
        buildVersionList();
        updateVersionLabels();
        updateHint();
        state.artRows = reframeRows(state.artRows, n());
        refresh(true);
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-preset]'), function (btn) {
      btn.addEventListener('click', function () {
        var rows = P.TEMPLATE_ROWS[btn.getAttribute('data-preset')];
        var bb = artBBox(rows);
        var need = Math.max(bb.w, bb.h) + 2;
        // auto-fit: bump the version until the surface can hold the template
        for (var v = state.version; v <= P.MAX_VERSION; v++) {
          if (P.canvasShape(state.url, v, { surface: state.surface }).width >= need) {
            if (v !== state.version) {
              state.version = v;
              $('#version').value = String(v);
            }
            break;
          }
        }
        setRows(rows);
      });
    });

    $('#clear').addEventListener('click', function () {
      pushUndo();
      state.artRows = Array.from({ length: n() }, function () { return '.'.repeat(n()); });
      refresh(true);
    });

    $('#undo').addEventListener('click', undo);
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undo();
      }
    });

    /**
     * Read a code from a file: a standard QR, or one of ours. Ours is not a
     * standard QR, so a phone camera cannot read it — the app is the reader.
     */
    $('#open-code').addEventListener('click', function () { $('#code-file').click(); });
    $('#code-file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      if (!file) return;
      var note = $('#read-note');
      var img = new Image();
      img.onload = function () {
        var size = Math.min(1024, Math.max(64, img.width));
        var c = document.createElement('canvas');
        c.width = c.height = size;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        var data = ctx.getImageData(0, 0, size, size).data;
        var read = P.readImage(data, size, size);
        if (!read) {
          note.textContent = 'Nothing readable in that file.';
          return;
        }
        note.textContent = read.kind === 'custom'
          ? 'Read a custom code (v' + read.version + '): ' + read.url
          : 'Read a standard QR: ' + read.url;
        state.url = read.url;
        $('#url').value = read.url;
        refresh(true);
      };
      img.onerror = function () {
        note.textContent = 'That file could not be opened as an image.';
      };
      img.src = URL.createObjectURL(file);
    });

    $('#upload').addEventListener('click', function () { $('#file').click(); });    $('#file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var img = new Image();
      img.onload = function () {
        // Downsample the image into the free surface (clipped to its shape)
        var size = n();
        var sh = state.result && state.result.canvas
          ? state.result.canvas : P.canvasShape(state.url, state.version, { surface: state.surface });
        var cw = sh.width;
        var c = document.createElement('canvas');
        c.width = c.height = cw;
        var ctx = c.getContext('2d');
        var s = Math.max(cw / img.width, cw / img.height);
        var w = img.width * s, h = img.height * s;
        ctx.drawImage(img, (cw - w) / 2, (cw - h) / 2, w, h);
        var data = ctx.getImageData(0, 0, cw, cw).data;
        var off = Math.floor((size - cw) / 2);
        var func = state.result && state.result.base
          ? state.result.base.func : P.buildFunctionMask(state.version);
        var blankRow = '.'.repeat(size);
        var rows = [];
        for (var y = 0; y < size; y++) rows.push(blankRow);
        for (var yy = 0; yy < cw; yy++) {
          var row = rows[off + yy].split('');
          for (var xx = 0; xx < cw; xx++) {
            var gx = off + xx, gy = off + yy;
            if (func[gy * size + gx]) continue; // locked skeleton
            if (!P.surfaceHas(sh.kind, sh.R, gx, gy, size)) continue; // outside the surface
            if (data[(yy * cw + xx) * 4] < 140) row[gx] = '#';
          }
          rows[off + yy] = row.join('');
        }
        pushUndo();
        state.artRows = rows;
        refresh(true);
      };
      img.src = URL.createObjectURL(file);
      this.value = '';
    });

    $('#dl-qr').addEventListener('click', function () {
      if (state.result) download(qrCanvas(16), 'pixelqr.png');
    });
    $('#dl-svg').addEventListener('click', function () {
      if (!state.result) return;
      var svg = P.toSVG(state.result.t.modules, n(), 12, 4, state.style, { finders: findersOf(state.result) });
      download(new Blob([svg], { type: 'image/svg+xml' }), 'pixelqr.svg');
    });
    $('#dl-avatar').addEventListener('click', function () {
      if (state.result) download(avatarCanvas(1024), 'avatar_1024.png');
    });
    $('#dl-avatar-preview').addEventListener('click', function () {
      if (state.result) download(avatarCanvas(260), 'avatar_preview_260.png');
    });
  }

  // ---------------- boot ----------------

  /**
   * Boot.
   *
   * The order matters: the drawing and the handlers come first, so that a
   * failure anywhere else still leaves a working app (you can paint, and the
   * paint recomputes the code). The drawing is painted before the fit — the
   * fit takes a moment, and an empty canvas reads as a page that failed to
   * load rather than one that is still working.
   */
  function boot() {
    buildVersionList();
    state.artRows = reframeRows(P.TEMPLATE_ROWS.CAT, n());
    wireEditor();
    wireControls();
    try { updateVersionLabels(); } catch (e) { /* the labels are a nicety */ }
    try { updateHint(); } catch (e) { /* so is the note */ }
    try {
      drawEditor();
      var badge = $('#badge');
      badge.className = 'badge';
      badge.textContent = '… working';
      var preview = $('#preview');
      preview.width = preview.height = (n() + 8) * PREVIEW_BOX;
      zoomLabel();
    } catch (e) { /* keep going: the fit is what matters */ }
    setTimeout(function () { refresh(true); }, 0);
  }

  boot();

  // expose for console play + tests
  window.PixelQRApp = { state: state, refresh: refresh, recompute: recompute, undo: undo };
})();
