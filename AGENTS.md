# AGENTS.md

Notes for anyone (human or AI agent) working on this repository.

## What this is

**Fabrica** is a single-page browser app for comparing fabric samples: paste
screenshots of fabrics, arrange/resize/rotate them on a board, put them on a
common real-world scale, and draw stitches on them in real thread colours
(Mettler Metrosene). See `PLAN.md` for the feature list and design decisions.

## Hard rules

- **No build step, no dependencies, no frameworks.** Plain HTML, CSS and
  JavaScript (ES2020). Do not add npm, bundlers or CDNs.
- **Must work from `file://`.** Use classic `<script>` tags (not ES modules).
  Every JS file is an IIFE that adds to the shared namespace:
  `(function (F) { ... })(window.Fabrica = window.Fabrica || {});`
- Script order in `index.html` matters: data → helpers → core → render →
  input → ui → main. Only reference other files' functions at call time
  (inside functions), never at load time, except in `main.js`.
- Keep the document model JSON-serialisable. Images are never put in the
  document; they live in `F.state.images` (id → `{blob, img, w, h}`).
- Every user-visible change to the document goes through
  `F.checkpoint()` (before the change, for undo) and `F.changed()` (after it,
  for redraw, autosave and UI refresh). For continuous edits (slider drags,
  pointer drags) checkpoint once at the start: use `F.beginEdit(key)` /
  `F.endEdit()` for inputs.

## Layout

```
index.html          markup for the toolbar, board, side panels, dialogs
styles.css          all styling
js/threads-metrosene.js  GENERATED Metrosene colour list (see tools/build_metrosene.py)
js/color.js         colour maths: hex/RGB/Lab/LCh, CIEDE2000, thread matching, suggestions
js/geom.js          vector maths, polyline simplify/smooth/sample, hit tests
js/stitches.js      procedural stitch rendering (running, back, zigzag, cross, blanket)
js/store.js         IndexedDB autosave, project file save/open, downloads
js/core.js          state, ids, history, document helpers, transforms, units, images
js/render.js        canvas rendering of the board, overlays, PNG export
js/input.js         pointer/keyboard/wheel/paste/drop handling and the tools
js/ui.js            side panels, toolbar, palette, inspector, toasts, help
js/demo.js          procedurally generated demo fabric swatches
js/main.js          boot: load saved board, wire everything up
tools/build_metrosene.py  regenerates js/threads-metrosene.js from Mettler's web page
```

## Coordinate systems

- **Screen**: CSS pixels relative to the canvas' top-left.
- **Board**: `screen = board * view.zoom + (view.x, view.y)`.
- **Clip-local (image pixels)**: origin at the image centre.
  `board = (clip.x, clip.y) + R(clip.rot) · diag(clip.scale · (flip ? -1 : 1), clip.scale) · local`.
  Use `F.toBoard(clip, p)` / `F.toLocal(clip, p)`; `clip = null` means the board.
- Stitch points and stitch sizes (`len`, `space`, `w`) are in the parent's
  local units. `F.unitsPerMm(clip)` converts mm ↔ local units:
  calibrated clips use their own `cal.pxPerCm`; others use the board's
  `doc.pxPerCm / clip.scale`.

## Real size and linking

- `clip.cal = {pxPerCm, ...}` — image pixels per cm, set by the Measure tool or
  the "real width" field.
- `clip.linked = true` — the clip resizes together with all other linked clips.
  Calibrated clips are linked at real size: `scale = doc.pxPerCm / cal.pxPerCm`.
- Any scale operation that touches a linked clip scales every linked clip around
  the same pivot and multiplies `doc.pxPerCm` by the same factor.

## Running and testing

- Open `index.html` in a browser, or serve the folder (better for clipboard
  APIs and storage):

  ```bash
  python3 -m http.server 8765
  ```

  then open <http://localhost:8765>. `.claude/launch.json` has the same config.
- There is no automated test suite. Test by hand in the browser: paste an
  image (or use "Try with demo swatches"), move/resize/rotate, multi-select,
  measure + link, draw each stitch type, pick colours, undo/redo, reload (the
  board should come back), save/open a file, export PNG. Check the console for
  errors.
- To simulate a paste from automation:
  ```js
  const dt = new DataTransfer(); dt.items.add(file);
  window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
  ```

## Thread data

The app uses one thread range: Mettler Metrosene all-purpose sewing thread
(318 colours). `js/threads-metrosene.js` is generated; do not edit it by hand.
Colour numbers and names come from
<https://www.amann-mettler.com/en/products/detail/metrosene/>. Mettler does
not publish RGB values, so each colour is estimated from Mettler's swatch photo
(middle of the picture, averaged in linear light, darkest/brightest 12 %
ignored). `tools/build_metrosene.py` explains how to download the page and
swatches and regenerate the file.

Screen colours of real threads are approximations; say so in the UI where it
matters. New thread brands go in their own `js/threads-<brand>.js` file
registering under `F.threadLibraries.<BRAND>` with the same
`[code, name, hex]` row format.

## Style

- 2-space indentation, semicolons, single quotes, `const`/`let`, no classes
  unless they really help. Small named functions over clever one-liners.
- UI text: short, plain English, sentence case. Use "sample" for a pasted
  image and "stitch" for a drawn stitch line.
- Keep the UI usable by someone who is not technical: label buttons, add
  `title` tooltips with shortcuts, and show a short hint for the active tool.
