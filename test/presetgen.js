/**
 * Preset workbench: builds SMILEY/HEART designs parameterically, checks their
 * envelope against the writable-canvas squircle, renders them through the
 * workbench pipeline at v4, prints ASCII + metrics, saves PNGs.
 * Usage: node test/presetgen.js
 */
'use strict';
const fs = require('fs');
const P = require('./../core.js');
const URL = 'https://USER.github.io';
const N = 29;
const C = 14;

function blank() { return Array.from({ length: N }, () => '.'.repeat(N)); }
function setPx(rows, x, y, ch) {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  rows[y] = rows[y].substring(0, x) + ch + rows[y].substring(x + 1);
}

function makeSmiley2(eyeW, eyeH, eyeX, eyeY, band, r) {
  const rows = blank();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x - C, dy = y - C;
    if (dx * dx + dy * dy <= r * r) setPx(rows, x, y, '#');
  }
  // eyes: white blocks
  for (let ey = eyeY; ey < eyeY + eyeH; ey++) {
    for (let ex = eyeX; ex < eyeX + eyeW; ex++) {
      setPx(rows, ex, ey, '.'); setPx(rows, 28 - ex, ey, '.');
    }
  }
  // smile: white ring segment (circle centred above, lower half only)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const d = Math.sqrt((x - C) * (x - C) + (y - C + 0.5) * (y - C + 0.5));
    if (y > C && d >= band[0] && d <= band[1]) setPx(rows, x, y, '.');
  }
  return rows;
}

function makeHeart(kx, ky, clip) {
  const rows = blank();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const X = (x - C) / kx, Y = (C - y) / ky;
    const a = X * X + Y * Y - 1;
    if (a * a * a - X * X * Y * Y * Y <= 0) {
      if (clip === undefined || P.squircleDist(x, y, N) <= clip) setPx(rows, x, y, '#');
    }
  }
  return rows;
}

function metrics(rows) {
  let ink = 0, maxDq = 0, mx = -1, my = -1, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (rows[y][x] !== '#') continue;
    ink++;
    const dq = P.squircleDist(x, y, N);
    if (dq > maxDq) { maxDq = dq; mx = x; my = y; }
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { ink, maxDq, argmax: '(' + mx + ',' + my + ')', bbox: (x1 - x0 + 1) + 'x' + (y1 - y0 + 1) };
}

function ascii(rows) {
  return rows.join('\n');
}

/** Centre a 29×29 template into the version grid (same as the app). */
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

function run(name, rows) {
  const m = metrics(rows);
  console.log('== ' + name + ' == ink=' + m.ink + ' bbox=' + m.bbox + ' maxDq=' + m.maxDq.toFixed(2) + ' at' + m.argmax);
  console.log(ascii(rows));
  const art = P.artFromRows(reframe(rows, 33));
  const t0 = Date.now();
  const w = P.fitWorkbench(URL, 4, art, { style: 'dots' });
  const ms = Date.now() - t0;
  console.log('fit v4: canvas ' + w.canvas.width + '×' + w.canvas.width + ' R=' + w.canvas.R +
    ' residual bg=' + w.residual.bg + ' ink=' + w.residual.ink +
    ' attempts=' + w.attempts + ' cw=' + w.t.cwUsed + '/' + w.t.cwBudget +
    ' padFix=' + (w.fit.pad ? w.fit.pad.fixed : 0) +
    ' verified=' + w.t.verified + '  ' + ms + 'ms\n');
  const img = P.renderRGBA(w.t.modules, 33, 16, 4, 'dots');
  fs.writeFileSync('/tmp/opencode/preset_' + name + '.raw', Buffer.from(img.data.buffer));
  fs.writeFileSync('/tmp/opencode/preset_' + name + '.meta', JSON.stringify({ w: img.width }));
  return { m, w };
}

/** Explicit pixel heart: deep V notch, lobes, straight taper to a point. */
function makeHeart2() {
  const rows = blank();
  const heart = [
    '..####...####..',
    '.#####...#####.',
    '.######.######.',
    '###############',
    '###############',
    '###############',
    '.#############.',
    '.#############.',
    '..###########..',
    '...#########...',
    '....#######....',
    '.....#####.....',
    '......###......',
    '.......#.......'
  ];
  for (let r = 0; r < heart.length; r++) {
    for (let c = 0; c < 15; c++) {
      if (heart[r][c] === '#') setPx(rows, 7 + c, 8 + r, '#');
    }
  }
  return rows;
}

/** ':D' face: solid disc, small eyes, white D-mouth (flat edge up, bowl down). */
function makeSmileyD(eyeW, eyeH, eyeX, eyeY, mouthR, mouthY) {
  const rows = blank();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x - C, dy = y - C;
    if (dx * dx + dy * dy <= 49) setPx(rows, x, y, '#');
  }
  // eyes: white blocks (mirrored)
  for (let ey = eyeY; ey < eyeY + eyeH; ey++) {
    for (let ex = eyeX; ex < eyeX + eyeW; ex++) {
      setPx(rows, ex, ey, '.'); setPx(rows, 28 - ex, ey, '.');
    }
  }
  // D-mouth: flat top + semicircular bowl below
  for (let y = mouthY; y <= C + 7; y++) {
    const dy = y - mouthY;
    const half = Math.floor(Math.sqrt(mouthR * mouthR - dy * dy) + 1e-9);
    if (isNaN(half)) break;
    for (let x = C - half; x <= C + half; x++) setPx(rows, x, y, '.');
  }
  return rows;
}

run('heartPix', makeHeart2());
run('faceH', makeSmileyD(3, 3, 10, 10, 4.5, 15));
run('cat', P.TEMPLATE_ROWS.CAT); // reference
