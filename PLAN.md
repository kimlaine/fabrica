# Fabrica — plan

A small browser app for laying out fabric sample screenshots next to each other,
trying thread colours on them and drawing stitches, so you can see how the
combination looks before buying anything.

## Goals

1. **Clippings board.** Paste screenshots (⌘V), drop image files, or pick files.
   Every image becomes a *sample* you can move, resize, rotate and flip on an
   endless board you can pan and zoom.
2. **Matching pattern scale.** Samples come from different shops at different
   zoom levels, so the app needs a way to put them on the same real-world scale
   and then resize them all together without losing that ratio.
3. **Stitches.** Draw stitches on a sample in a chosen thread colour. Choose the
   stitch type, stitch length, gap and thread thickness, and change them later,
   per stitch or for all the stitches on one sample.
4. **Real thread colours.** Choose from the DMC stranded cotton range (the
   best-known thread colour card; 454 colours with approximate screen colours),
   or any colour from the system colour wheel. Pick a colour from a fabric and
   get thread suggestions: closest match, lighter/darker, contrast, neighbours.
5. **Keep work.** Autosave in the browser, save/open project files, export PNG.

Non-goals for v1: accounts, cloud sync, collaboration, a build step, frameworks.

## Key design decisions

- **Plain HTML/CSS/JS, no build step, no dependencies.** Classic `<script>`
  files share one global namespace (`window.Fabrica`), so the app also works
  when `index.html` is opened directly from disk.
- **One `<canvas>` for the board.** Everything is redrawn from a small document
  model on each change. Images are drawn with transforms; stitches are drawn
  procedurally. Hit-testing is done with plain geometry.
- **Document model** (JSON, small; images live separately, keyed by id):
  - `clips[]` — samples, in z-order: `{id, imageId, name, x, y, scale, rot,
    flip, w, h, cal, linked}`. `(x, y)` is the centre on the board, `w, h` the
    image's pixel size, `cal` the real-size calibration.
  - `stitches[]` — `{id, parent, pts, kind, len, space, w, color, thread}`.
    `parent` is a clip id (or `null` for a stitch drawn on the empty board).
    Points and sizes are in the parent's *image pixels*, so a stitch moves,
    rotates and scales with its sample, which is what real stitches on a piece
    of fabric do.
  - `pxPerCm` — the board's real-size scale, `bg`, `grid`, `shadows`.
- **Stitches render on a layer above all samples** (ordered by their sample's
  z-order). That lets a stitch run across a seam between two samples.
- **Real size and scale linking.**
  - The Measure tool: drag a line over something of known size on a sample
    (a ruler in the photo, one pattern repeat, the stated image width), type
    the length → the sample knows its image pixels per cm.
  - A measured sample is shown at the board's real-size scale and marked
    *linked*. All linked samples resize together: dragging the resize handle of
    any linked sample, or moving the board's "1 cm = N px" slider, scales all
    of them around a common point, so pattern ratios and layout stay intact.
  - Unmeasured samples can also be linked by hand (match them by eye once,
    then link them).
  - Multi-select (shift-click / drag a box / ⌘A) and the group handles also
    resize any selection together.
- **Stitch sizes are shown in millimetres.** For measured samples this is real;
  for unmeasured ones it is relative to the board scale. New stitches use the
  tool settings in mm, converted to the sample's image pixels.
- **Undo/redo** by snapshotting the document JSON before each change (images
  are kept in memory for the session, so undo can restore deleted samples).
- **Storage.** IndexedDB holds the document and image blobs (autosaved).
  Project files are `.fabrica.json` with images embedded as data URLs.

## Features (v1)

Board
- Paste (⌘V), drag-and-drop, or "Add images". Pastes keep their on-screen size
  (Retina screenshots are shown at 1/devicePixelRatio), so screenshots taken at
  the same zoom stay comparable.
- Pan: two-finger scroll, Space+drag, middle mouse, or the Pan tool. Zoom:
  pinch, ⌘/Ctrl+scroll, zoom buttons, fit-all.
- Background colour presets, optional 1 cm grid, optional paper shadows.
- "Try with demo swatches" button that generates a few fabric swatches, for
  trying the app without screenshots.

Samples
- Select, shift-click/box multi-select, move (with edge snapping so samples
  butt together neatly; hold ⌘/Ctrl to disable), Alt+drag to duplicate.
- Corner handles resize keeping the aspect ratio (Alt = around the centre),
  rotation handle (Shift snaps to 15°), flip, ±90°, layer order.
- Inspector: name, size %, rotation, real width (cm), measure, link size,
  "edit this sample's stitches".
- Arrange the selection side by side or in a grid (touching or with a gap).

Stitches
- Stitch tool: drag on a sample (freehand, smoothed) or Shift+drag (straight).
- Types: running, back, zigzag, cross, blanket.
- Settings: stitch length, gap / zigzag width / blanket height, thread
  thickness, plus approximate presets (sewing thread, topstitching, 2/3/6
  strands of floss, pearl cotton, sashiko).
- The thread is drawn with a shadow, highlight and twist so it reads as thread.
- Editing settings while stitches are selected changes those stitches.
  "Edit these stitches" on a sample selects all its stitches at once.

Thread colours
- DMC palette with search (number or name) and sorting (colour card, number,
  hue, lightness).
- Custom colour via the system colour picker (macOS shows the colour wheel),
  with the closest DMC matches.
- Pick tool (I, or Alt+click in the Stitch tool): click a fabric → closest
  threads, lighter/darker, contrast, and neighbouring colours, all mapped to
  real DMC numbers (CIEDE2000 colour distance).
- "Threads in this design" list (a shopping list); click to select those
  stitches.

Files
- Autosave to the browser, Save / Open `.fabrica.json`, Export PNG (whole
  board or just the selection), Copy image where the browser allows it.

## Steps

1. Write this plan and `AGENTS.md`.
2. Generate `js/threads-dmc.js` from the MIT-licensed DMC dataset
   (`tools/build_dmc.py`).
3. Core: state, ids, geometry, transforms, history, images, storage.
4. Rendering: board, samples, stitches, overlays, export.
5. Interaction: tools, selection, transforms, snapping, paste/drop, keys.
6. UI: toolbar, inspector, stitch panel, thread panel, board panel, help.
7. Test in a browser: paste/drop, transforms, linked scaling, measuring,
   stitches, colour suggestions, undo, reload persistence, save/open, export.

## Later ideas

- Crop a sample (screenshots often include page clutter).
- More thread brands (Anchor, Gütermann, Aurifil) if good colour data exists.
- Multiple boards, named.
- Touch: two-finger pinch on iPad.
- Fabric repeat preview (tile a sample to see a larger piece).
- Satin stitch / fill areas.
