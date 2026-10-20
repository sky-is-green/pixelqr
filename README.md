
# PixelQR

Paint pixel art. It becomes a **real, scannable QR code**: the art *is* the code. 

Live at: https://sky-is-green.github.io/pixelqr/

<img width="300" height="300" alt="1024_cut" src="https://github.com/user-attachments/assets/60c2c521-41e9-4ad8-be53-344b966201c4" /> <img width="300" height="300" alt="avatar_1024(2)" src="https://github.com/user-attachments/assets/2575c420-10ee-45d4-885e-e760ad3050ea" />


No server, no build step, no CDN: everything runs in the browser, works from
`file://`, and can be embedded in your website (see below).

## Quick start

Open `index.html` in a browser. That's it.

Or, for a local URL:

```sh
python3 -m http.server 8765     # then open http://localhost:8765
```

Verify the engine headlessly:

```sh
node test/verify.js
node test/pipeline.js
```

## What it does

- **Two backends.** *Standard* is an ordinary QR code: any phone camera reads
  it. *Custom* is my own layout: a circular grid with the finder patterns
  inside it, so the code fills a round profile picture edge to edge. It reads
  with the engine's own decoder, not with a phone camera.
- **Draw** on a module grid inside the **free surface**: a region (dashed
  outline) whose size is derived from the code's error budget. Everything
  inside is guaranteed clean: **zero random code cells, ever**. The fog of QR
  noise is pushed outside, into the hatched ring.
- **The surface's shape is yours**: a rounded square, a circle (the round
  profile picture) or a cross reaching to the code's edges.
- **Ink or erase**. Every cell of the surface is pinned: ink wants dark,
  background wants light, and the engine spends its budget pinning both. What
  you paint is what scans.
- **The code ring**: the hatched zone around the surface carries the QR's own
  random cells (plus finder/timing skeleton). That randomness is what makes
  each link unique; it never mixes with your art.
- **Free payload bits**: on top of the flip budget, the pad codewords after
  the payload terminator (bits decoders never read) are *solved* with linear
  algebra to pin more surface cells exactly, for free. No scan margin spent.
- **Versions 3–13** (29–69 modules). Every version buys a bigger error budget,
  and a bigger budget buys a bigger free surface: ~17×17 cells at v4, ~23×23
  at v6, ~35×35 at v10 for a 22-character link. A version that could never
  hold the link (or would leave no room to draw) is greyed out in the list.
- **The alignment patterns are the code's, not yours.** From v7 on, a QR code
  carries 5×5 alignment patterns, and one of them sits exactly in the middle:
  in the middle of the drawing area. Its position is fixed by the spec and the
  decoder needs it to find the code's own geometry (blanking it stops the
  read), so it stays blank. The custom backend has no alignment patterns at
  all, so nothing interrupts the drawing there.
- **Styles**: `square`, `dots` (tangent circles), `squircle` (soft-square
  superellipse), `hexagon` (honeycomb tiles + hexagon eyes), `leaf`
  (interlocking petals + leaf-shaped eyes) and `diamond` (diagonal lattice).
  Styling turns the ring's texture from "noise" into "design"; where a style
  has a natural ring shape, the three finder eyes wear it too. Every style is
  verified by decoding the styled render itself.
- **Red dots** mark drawn ink the budget couldn't realize: switch to a higher
  version (bigger surface) or erase that bit.
- **A roomy editor and a zoom.** The drawing grid gets the wider column and
  most of the page, and the zoom (½× to 4×, or ctrl+wheel) makes the cells
  bigger for fine detail, redrawn at the new size rather than scaled, so it
  stays crisp, and the view keeps the same cell in the middle. Half is the
  overview: the whole grid at once.
- **Undo** (Ctrl/Cmd+Z or the button) steps back through edits.
- **Live verification**: after every edit the code is decoded in-browser with a
  real QR decoder (jsQR), both crisp and shrunk+blurred (simulating scanning at
  a distance). The badge shows the result. If decoding fails, the flip budget
  is automatically trimmed until it passes.
- **Export**: QR PNG, SVG, a 1024px round avatar, and a round avatar preview.

## Round profile pictures

A profile picture is a circle, and a circle has no corners: the three finder
patterns of a square QR sit exactly where a circular crop would eat them. So
there are two answers, one per backend:

- **Standard**: the QR square is *inscribed* in the circle, so all three eyes
  are inside it and the circle itself is the quiet zone. Any phone reads it.
  The export checks the render with a real decoder and steps the module size
  down if a styled render happens to lose a finder at that scale.
- **Custom**: the grid is a disc and the eyes sit inside it, 120° apart, so
  the code fills the circle edge to edge. The payload, the Reed-Solomon coding,
  the interleaving and the mask are all the standard ones; only the *layout* is
  mine, which means it is not a standard QR: only a decoder that knows the
  layout reads it.

## How it works

A QR code at error-correction level H survives up to ~30% damage: that's a
budget, and PixelQR spends it to carve out one region of the code that becomes
**fully yours**.

1. **The free surface**. The design area is a region of your choosing: a
   rounded-square *squircle*
   (`max(|dx|,|dy|) + 0.35·min(|dx|,|dy|)`), a circle, or a cross. Inside it,
   every cell is pinned to the drawing (ink → dark, rest → light) at high
   weight; outside, background cells keep the QR's own randomness (weight
   floor): the two never trade off. Painting is restricted to the surface;
   the ring is code.
2. **Surface sizing from the budget**: the unit of error correction is the
   **codeword**, eight modules along the placement walk. A codeword may be
   sacrificed once per RS block, and the placement walk hands codewords out in
   runs, so the surface's codewords are *not* spread evenly over the blocks:
   the tightest block decides how big the surface can be. The estimate uses
   the real codeword counts; the grow pass then pushes the surface out in
   quarter-cell steps while the promise still holds, so the surface ends up as
   large as the budget genuinely allows.
3. **The zero-residual guarantee**: after the fit, the engine counts every
   remaining background-dark cell inside the surface. If any survive, it tries
   (a) the runner-up encodings from the search at the same size, then
   (b) a full re-search, and only as a last resort (c) shrinks the surface one
   step and re-runs, until the count is exactly **zero**. A surface is never
   reported with stray noise in it.
4. **Pattern-fit search**: the popup pattern depends on the payload and the
   mask. The app quietly tries short, harmless link fragments (`#`, `#0`…`#z`:
   anchor only, the page is unchanged) × all 8 masks, and keeps the encoding
   whose free cells fit the drawing best. ~30–40 ms; strokes reuse the
   established encoding (~25 ms).
5. **Codeword sacrifice**: flipping a codeword's bits still costs the decoder
   only *one* error, so the engine ranks codewords by conflict mass (ink cells
   weighted 3×) and sacrifices whole codewords within each RS block's error
   capacity.
6. **Payload freedom (free cells)**: after the payload terminator the
   encoder writes padding codewords (EC/11) that **decoders never read**
   (ISO/IEC 18004: "pad codewords shall have no significance"), but they do
   show up in the module pattern. The map from a pad bit to the module matrix
   is XOR-linear (RS coding, interleaving and masking are all linear over
   GF(2)), so the engine computes each pad bit's *influence set* once, then
   solves a Gauss-Jordan system over GF(2) for the pad values that toggle up
   to `padBits` target modules exactly, zero error budget spent, decoded
   payload byte-for-byte intact. This is the same family of trick as
   QArt/QArtText codes; the decoded link is unchanged.
7. The 7 *remainder bits* (v3–13) carry no data, always free to paint.
8. **Styled rendering**: dots or rounded tiles with rounded finder rings,
   with decode verification applied to the rendered style (crisp, blurred and
   downscaled). Tangent dots (diameter = 1 module) were chosen after probing
   the decoder: smaller dots look fine but sit below the safety margin at
   large module sizes.
9. Locked structural cells are never touched.
10. Result is verified by decoding (crisp + stressed). Auto-trim on failure.

With the workbench model a cat at v4 lands with **100% of its ink realized**
inside a surface that is **100% free of random cells**, and still decodes after
blur and downscale. The retry/shrink loop spends its effort only when the
budget is genuinely marginal.

## The custom backend in detail

The custom pipeline keeps everything that makes a QR code a QR code (the
payload, the byte-mode encoding, the Reed-Solomon coding, the block
interleaving, the eight masks, the placement walk, the free-pad-bit solver)
and changes one thing: **the layout**.

- The grid is a **disc**: the version's code words, plus the three finder
  patterns, laid out on the cells nearest the centre of a square grid. The
  disc's radius follows from the version; the finders are placed as far out as
  they fit, 120° apart.
- The walk is the same column-pair zigzag, restricted to the disc.
- The engine carries its own **Reed-Solomon decoder** (syndromes,
  Berlekamp-Massey, Chien search, Forney) to read the result back, art and all.
  The standard pipeline gets that from jsQR instead.
- The verification is honest: the same promise (zero random cells inside the
  surface, every stroke realized, the payload intact) is checked with the
  engine's own decoder.

## Controls

| Control | What it does |
|---|---|
| Generation: standard / custom | The ordinary QR, or my own circular layout |
| Brush: ink / erase | Paint a module dark, or back to light (right-click erases too) |
| Surface: square / circle / cross | The shape of the free area (a cross is thin: only v12 has room to draw in it) |
| Style: square / dots / squircle / hexagon / leaf / diamond | How the final code is rendered: every style is decode-verified as rendered (crisp, blurred, downscaled) |
| Presets: cat / smiley / heart | Load a module-resolution template |
| Upload image | Downsample any image to the grid (dark/light threshold) |
| Clear | Wipe every drawing: the surface goes back to blank (undo brings it back) |
| Undo | Ctrl/Cmd+Z or the button: steps back through edits |
| Zoom: − / 1× / + | ½× to 4× (also ctrl+wheel). Bigger cells for finer detail; ½× is the overview. The grid is redrawn at the new cell size, so it stays crisp, and the frame scrolls when it outgrows the panel: the same cell stays in the middle |
| Link to → | The URL the QR encodes |
| Version | v3–v13 = 29–69 modules; each shows the surface it would give this link, and the ones that cannot hold the link are greyed out (auto-fit: loading a preset bumps the version until it fits). Switching reframes your art (centred, no distortion) |
| Mask | auto / 0–7 / shuffle: auto runs the pattern-fit search (may add a `#x` anchor fragment to the link); a fixed mask keeps your exact link |
| PNG / SVG / Avatar 1024 / Avatar preview | Exports: the avatars are the round profile picture |

The editor draws the free surface's edge in blue, so what you can paint on is
plain to see. From v7 on, the alignment pattern that sits in the middle of the
drawing area gets the same blue outline: it is a hole in the surface, not
something you can draw on.

## Embedding on a site (GitHub Pages)

The folder is fully static. Either

- copy `pixelqr/` into the site repo and link to it, or
- `<iframe src="/pixelqr/index.html" style="width:100%;height:900px;border:0"></iframe>`.

No external requests at runtime. The app is themeable via `style.css`.

**Bump `?v=` when the app changes.** `index.html` loads `style.css`, `core.js`
and `app.js` with a version query. The app's files change together, and a
browser that kept the old `core.js` in its cache while fetching the new
`app.js` gets a mix that cannot work: the old engine does not have what the
new app asks of it. The query string makes the browser fetch all of them
afresh, as a set. The app also survives such a mix: the boot wires the
drawing and the controls first and treats the version labels and the note as
niceties, so a failure there cannot stop the code from being built, and the
drawing is painted before the fit, so a slow first fit looks like work rather
than like a broken page.

## Files

```
index.html          UI markup
style.css           theme
favicon.svg         the tab icon: a tiny QR that only has to look like one
app.js              editor, preview, badges, exports
core.js             engine (DOM-free; node-requirable)
lib/qrcode.js       qrcode-generator (MIT, Kazuhiko Arase), patched: make(forcedMask), QRRSBlock export
lib/jsQR.js         jsQR (Apache-2.0), in-browser decoder for live verification
test/verify.js      node suite: structural roundtrip + tolerance sweep
test/pad.js         node suite: payload-freedom (linearity, solve, decode) + style decode battery
test/canvas.js      node suite: writable-canvas sizing + zero-residual guarantee + decode battery
test/pipeline.js    node suite: surfaces × versions, the custom backend, the round avatar
test/styles.js      style lab: decode matrix across 7 module styles × sizes
test/repro.js       visual check: art vs result sheet, ink-realized / contrast metrics
test/catgen.js      cat preset workbench: builds the template, prints art vs result + metrics
```

## What `test/verify.js` proves

- **Structural roundtrip**: bits are extracted from the rendered QR (inverse
  placement walk + mask removal), de-interleaved and parsed back to the URL,
  bit-exact for v3/v4 × all 8 masks. This validates the walk, the mask
  formulas, the function-mask geometry and the RS block mapping.
- **Tolerance sweep**: flips vs strength, decoding at decreasing sizes with
  blur, for all templates and masks.

`test/pad.js` additionally proves:

- **Pad write-through**: custom pad codewords land verbatim in the data
  stream and the code still decodes.
- **Linearity**: `encode(pads) == encode(0) XOR ⊕ influences(set bits)`,
  module-exact for v3 and v4. This is the assumption the solver rests on.
- **Solve quality**: padding vs no padding; conflicts and score improve,
  decode stays verified (v3: 49 cells fixed free; v4: 132).
- **Style battery**: square/rounded/dots × (296px, 148px+blur, 111px+blur),
  all styles decode.

`test/canvas.js` additionally proves:

- **Sizing**: canvas width per version for a given link (13/19/21/25 cells
  at v3–v6 for a 22-char link).
- **The zero-residual promise**: blank canvas and a cat at v3–v6; background
  stray cells = 0, unrealized ink = 0, decode verified.
- **Reuse fast path**: a stroke re-fit keeps the encoding, keeps the canvas
  size, and still zeroes (the browser path uses this).
- **Preset auto-fit**: the smallest version whose canvas can hold the cat.

`test/pipeline.js` additionally proves:

- **Surfaces**: square, circle and cross all keep the promise (zero random
  cells inside, every stroke realized, the code still decodes).
- **The version range**: v3 to v13 all build, fit and decode; bigger versions
  really do buy a bigger surface.
- **The custom backend**: encodes and decodes, realizes the art, and leaves
  the corners free of finder patterns.
- **The round avatar**: the standard QR, inscribed in the circle, still
  decodes after the circular crop.

## Prior art (what commercial/OSS art-QR does, and what I took)

- **Halftone QR (Chu et al., SIGGRAPH Asia 2013)**: replaces each dark module
  with a 3×3 submodule tile and sacrifices a third of the error budget to
  encode a backdrop image. Powerful, but the submodule grid is visually
  invasive and scan-marginal; **rejected**.
- **QArt / QArtText (Russ Cox)**: solves *unused* payload bits (padding) over
  GF(2) so the picture is painted with zero errors, and brute-forces the mask
  for the best fit. **Adopted** (my `padSolve` is the same idea; the mask +
  fragment search was already in).
- **qr-code-styling / QRCode Monkey / Unitag (commercial "design QR")**:
  module styling (dots / rounded / extra-rounded), styled finder eyes, and
  `hideBackgroundDots`. **Adopted**: my style renderer redraws modules and
  finder rings, and every style is decode-verified in-repo.
- **Logo-in-the-middle (commercial)**: eats error budget with a big opaque
  logo. I do the opposite: solve the middle *clean* for free, then paint it
  with budget.

## Known limits

- Versions 3–13 are supported (the full alignment-pattern layout and the
  version-information blocks from v7 on).
- The encoded URL must fit the chosen version at level H. The app greys out
  the versions that cannot hold the link, and bumps the version if the link
  outgrows the one you are on.
- The alignment patterns are fixed by the spec and load-bearing for the
  decoder: from v7 on, one sits in the middle of the drawing area and stays
  blank. The custom backend has none.
- The surface is sized by physics, not preference: a bigger surface needs a
  bigger error budget. For a 22-char link that means ~13×13 cells at v3,
  ~17×17 at v4, ~19×19 at v5, ~23×23 at v6, ~35×35 at v10. Shorter links grow
  the surface (more free pad bits). A cross is thinner still: only v12 gives
  its arms room to draw in, so that is the only version it is offered with.
- The custom backend is **not a standard QR**. It is a QR-shaped code with my
  own layout: a phone camera will not read it. Use it when the shape matters
  more than the compatibility.
- Very small renders (≤40px) are intentionally unscannable: that's the
  intrigue effect when used as an avatar.
- The ring around the surface is genuinely random (that's the code); it is
  never paintable, and it never reaches inside the surface. The visual calm at
  small sizes comes from the styling (dots/rounded) on top.
- Style safety was tuned against jsQR (see `test/styles.js`): the six shipped
  styles (square, dots, squircle, hexagon, leaf, diamond) decode clean from
  592px down to 111px blurred. Findings that shaped the shapes: tangent dots
  (r = 0.5 module, not smaller); hexagons flat-topped with vertex overlap;
  leaf corners rounded to ~90% of the half-module. Finder eyes wear the
  style's shape where it has one (circles, hexagons, leaf petals) and are
  clipped to the 7×7 finder zone so pointed rings never pollute the
  separator. Shapes that did NOT survive the bar: triangles, plus/cross
  tiles and rounded/octagon (dropped as near-duplicates of squircle/hexagon
  in review); their functions remain in the lab for reference.
