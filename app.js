/**
 * PixelQR app — pixel art ⇄ QR editor.
 * Core engine: core.js (PixelQR). Decoder: lib/jsQR.js. Encoder: lib/qrcode.js.
 */
(function () {
  'use strict';

  var P = window.PixelQR;
  var CELL = 16;          // editor cell size (px)
  var PREVIEW_BOX = 12;   // preview module size (px)

  var state = {
    version: 6,                              // default: the biggest canvas, most room to draw
    mask: 'auto',
    brush: 1,                                // 1 = ink, 0 = erase
    style: 'dots',                           // render style: square | rounded | dots
    url: 'https://USER.github.io',
    artRows: reframeRows(P.TEMPLATE_ROWS.CAT, 6 * 4 + 17),  // v6 canvas (n = version * 4 + 17)
    result: null,
    error: null
  };
  var labeledUrl = null; // which url the version labels reflect

  var undoStack = [];

  // ---------------- helpers ----------------

  function $(sel) { return document.querySelector(sel); }
  function n() { return state.version * 4 + 17; }

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

  /** Version labels show the canvas each version would give for this link. */
  function updateVersionLabels() {
    Array.prototype.forEach.call($('#version').options, function (opt) {
      var v = parseInt(opt.value, 10);
      var sh = P.canvasShape(state.url, v);
      opt.textContent = 'v' + v + ' · ' + (v * 4 + 17) + '×' + (v * 4 + 17) +
        ' · canvas ' + sh.width + '×' + sh.width;
    });
  }

  /**
   * Draw a module matrix. Styles mirror core.renderRGBA:
   * square (crisp), rounded (soft tiles), dots — styled variants redraw the
   * three finders as rounded rings. The editor panel keeps plain squares.
   */
  function drawMatrix(ctx, modules, size, box, border, offX, offY, style) {
    style = style || 'square';
    ctx.fillStyle = 'white';
    ctx.fillRect(offX, offY, (size + 2 * border) * box, (size + 2 * border) * box);
    ctx.fillStyle = 'black';
    if (style === 'square') {
      for (var y0 = 0; y0 < size; y0++) {
        for (var x0 = 0; x0 < size; x0++) {
          if (modules[y0 * size + x0]) {
            ctx.fillRect(offX + (x0 + border) * box, offY + (y0 + border) * box, box, box);
          }
        }
      }
      return;
    }
    var inFinder = function (x, y) {
      return (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
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
    var zones = [[0, 0], [size - 7, 0], [0, size - 7]];
    for (var f = 0; f < 3; f++) {
      var zx = offX + (zones[f][0] + border) * box, zy = offY + (zones[f][1] + border) * box;
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
        prev.maskChoice === state.mask;
      var w = P.fitWorkbench(state.url, state.version, art, {
        mask: state.mask === 'auto' ? 'auto' : state.mask,
        style: state.style,
        margin: 1.0,
        // strokes re-use the established encoding + canvas (fast, stable while painting)
        reuse: sameCode ? { mask: prev.mask, suffix: prev.suffix } : null,
        canvasR: sameCode ? prev.canvas.R : undefined
      });
      state.result = {
        base: w.fit.base, t: w.t, mask: w.fit.mask, suffix: w.fit.suffix,
        pad: w.fit.pad || null, canvas: w.canvas, residual: w.residual,
        url: state.url, version: state.version, maskChoice: state.mask
      };
    } catch (e) {
      state.result = null;
      state.error = (typeof e === 'string') ? e : (e && e.message) || 'QR build failed';
    }
    if (labeledUrl !== state.url) {
      updateVersionLabels();
      labeledUrl = state.url;
    }
    drawEditor();
    drawPreview();
    updateStatus();
  }

  // ---------------- editor ----------------

  function drawEditor() {
    var canvasEl = $('#editor');
    var size = n();
    canvasEl.width = canvasEl.height = size * CELL + 1;
    var ctx = canvasEl.getContext('2d');
    ctx.fillStyle = '#14141b';
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

    var func = P.buildFunctionMask(state.version);
    var result = state.result;
    var canR = result && result.canvas ? result.canvas.R : null;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var i = y * size + x;
        var px = x * CELL, py = y * CELL;
        var ch = state.artRows[y][x];
        var outside = canR !== null && P.squircleDist(x, y, size) > canR;
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
          // Writable canvas. (Leftover ink that ended up outside after a
          // version/canvas change is shown too — red-dotted, ready to erase.)
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
    // writable-canvas boundary (drawn along the cell edges between the
    // canvas and the code ring)
    if (canR !== null && result) {
      ctx.strokeStyle = 'rgba(110, 231, 183, 0.6)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (var yy = 0; yy < size; yy++) {
        for (var xx = 0; xx < size; xx++) {
          if (P.squircleDist(xx, yy, size) > canR) continue;
          if (yy === 0 || P.squircleDist(xx, yy - 1, size) > canR) {
            ctx.moveTo(xx * CELL, yy * CELL + 1.5); ctx.lineTo((xx + 1) * CELL, yy * CELL + 1.5);
          }
          if (yy === size - 1 || P.squircleDist(xx, yy + 1, size) > canR) {
            ctx.moveTo(xx * CELL, (yy + 1) * CELL - 1.5); ctx.lineTo((xx + 1) * CELL, (yy + 1) * CELL - 1.5);
          }
          if (xx === 0 || P.squircleDist(xx - 1, yy, size) > canR) {
            ctx.moveTo(xx * CELL + 1.5, yy * CELL); ctx.lineTo(xx * CELL + 1.5, (yy + 1) * CELL);
          }
          if (xx === size - 1 || P.squircleDist(xx + 1, yy, size) > canR) {
            ctx.moveTo((xx + 1) * CELL - 1.5, yy * CELL); ctx.lineTo((xx + 1) * CELL - 1.5, (yy + 1) * CELL);
          }
        }
      }
      ctx.stroke();
    }
  }

  function cellFromEvent(evt) {
    var rect = $('#editor').getBoundingClientRect();
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
    var func = P.buildFunctionMask(state.version);
    if (func[c.y * size + c.x]) return; // locked skeleton
    var ch = forced !== undefined ? forced : (state.brush === 1 ? '#' : '.');
    var res = state.result;
    if (ch === '#' && res && res.canvas && P.squircleDist(c.x, c.y, size) > res.canvas.R) {
      return; // the writable canvas is the design area — the ring stays code
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
      canvas.setPointerCapture(e.pointerId);
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
    drawMatrix(ctx, state.result.t.modules, size, PREVIEW_BOX, 4, 0, 0, state.style);
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
    if (t.verified) {
      badge.classList.add('ok');
      badge.textContent = t.iterations > 1
        ? '✓ Scannable (auto-tuned)'
        : '✓ Scannable — clean & at distance';
      var parts = [
        'canvas ' + can.width + '×' + can.width +
          (res.bg === 0 ? ' — zero random cells inside' : ' — ' + res.bg + ' stray cells left'),
        res.ink === 0 ? 'all ink realized' : res.ink + ' ink cells unrealized',
        t.cwUsed + '/' + t.cwBudget + ' codewords sacrificed'
      ];
      if (state.result.suffix) parts.push('pattern-fit ' + state.result.suffix + ' added to link');
      if (state.result.pad && state.result.pad.fixed > 0) {
        parts.push(state.result.pad.fixed + ' cells fixed by free payload bits');
      }
      parts.push('decode-verified at 296px + 148px blurred, as rendered');
      detail.textContent = parts.join(' · ');
    } else {
      badge.classList.add('bad');
      badge.textContent = '✗ Not decodable with this art';
      detail.textContent = 'Too many conflicting paints — erase some strokes or switch to a higher version (bigger canvas).';
    }
    $('#stats').textContent = 'v' + base.version + ' · ' + n() + '×' + n() + ' modules · mask ' +
      state.result.mask + ' · ' + state.style + ' style · canvas ' + can.width + '×' + can.width +
      ' · ' + base.drawable + ' drawable cells';
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
    drawMatrix(c.getContext('2d'), state.result.t.modules, size, box, 4, 0, 0, state.style);
    return c;
  }

  function avatarCanvas() {
    var size = n();
    var c = document.createElement('canvas');
    c.width = c.height = 1024;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1024, 1024);
    var target = Math.round(1024 * 0.578);
    var box = Math.max(1, Math.floor(target / (size + 8)));
    var side = box * (size + 8);
    var off = Math.round((1024 - side) / 2);
    drawMatrix(ctx, state.result.t.modules, size, box, 4, off, off, state.style);
    return c;
  }

  function avatarPreviewCanvas(sizePx) {
    var c = document.createElement('canvas');
    c.width = c.height = sizePx;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(0, 0, sizePx, sizePx);
    ctx.save();
    ctx.beginPath();
    ctx.arc(sizePx / 2, sizePx / 2, sizePx / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(avatarCanvas(), 0, 0, sizePx, sizePx);
    ctx.restore();
    return c;
  }

  function wireControls() {
    $('#url').addEventListener('input', function () {
      state.url = this.value || 'https://USER.github.io';
      refresh();
    });

    $('#version').addEventListener('change', function () {
      state.version = parseInt(this.value, 10);
      state.artRows = reframeRows(state.artRows, n());
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

    Array.prototype.forEach.call(document.querySelectorAll('[data-preset]'), function (btn) {
      btn.addEventListener('click', function () {
        var rows = P.TEMPLATE_ROWS[btn.getAttribute('data-preset')];
        var bb = artBBox(rows);
        var need = Math.max(bb.w, bb.h) + 2;
        // auto-fit: bump the version until the canvas can hold the template
        for (var v = state.version; v <= 6; v++) {
          if (P.canvasShape(state.url, v).width >= need) {
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

    $('#upload').addEventListener('click', function () { $('#file').click(); });
    $('#file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var img = new Image();
      img.onload = function () {
        // Downsample the image into the writable canvas (clipped to its shape)
        var size = n();
        var sh = state.result && state.result.canvas
          ? state.result.canvas : P.canvasShape(state.url, state.version);
        var cw = sh.width;
        var c = document.createElement('canvas');
        c.width = c.height = cw;
        var ctx = c.getContext('2d');
        var s = Math.max(cw / img.width, cw / img.height);
        var w = img.width * s, h = img.height * s;
        ctx.drawImage(img, (cw - w) / 2, (cw - h) / 2, w, h);
        var data = ctx.getImageData(0, 0, cw, cw).data;
        var off = Math.floor((size - cw) / 2);
        var func = P.buildFunctionMask(state.version);
        var blankRow = '.'.repeat(size);
        var rows = [];
        for (var y = 0; y < size; y++) rows.push(blankRow);
        for (var yy = 0; yy < cw; yy++) {
          var row = rows[off + yy].split('');
          for (var xx = 0; xx < cw; xx++) {
            var gx = off + xx, gy = off + yy;
            if (func[gy * size + gx]) continue; // locked skeleton
            if (P.squircleDist(gx, gy, size) > sh.R) continue; // outside the canvas
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
      var svg = P.toSVG(state.result.t.modules, n(), 12, 4, state.style);
      download(new Blob([svg], { type: 'image/svg+xml' }), 'pixelqr.svg');
    });
    $('#dl-avatar').addEventListener('click', function () {
      if (state.result) download(avatarCanvas(), 'avatar_1024.png');
    });
    $('#dl-avatar-preview').addEventListener('click', function () {
      if (state.result) download(avatarPreviewCanvas(260), 'avatar_preview_260.png');
    });
  }

  // ---------------- boot ----------------

  wireEditor();
  wireControls();
  updateVersionLabels();
  refresh(true);

  // expose for console play + tests
  window.PixelQRApp = { state: state, refresh: refresh, recompute: recompute, undo: undo };
})();
