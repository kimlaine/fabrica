// State, document helpers, history, transforms, units, images.
(function (F) {
  'use strict';

  const G = F.geom;

  F.newDoc = function () {
    return {
      app: 'fabrica',
      version: 1,
      pxPerCm: 40,
      bg: '#F3EFE6',
      grid: false,
      shadows: true,
      clips: [],
      stitches: [],
    };
  };

  const S = (F.state = {
    doc: F.newDoc(),
    view: { x: 0, y: 0, zoom: 1 },
    sel: new Set(),
    tool: 'select',
    images: new Map(), // id → { blob, img, url, w, h }
    version: 0,
    opts: {
      kind: 'running',
      kinds: {
        running: { len: 4, space: 2.5 },
        back: { len: 3, space: 0 },
        zigzag: { len: 2, space: 3 },
        cross: { len: 3, space: 0 },
        blanket: { len: 5, space: 4 },
      },
      width: 0.6,
      color: '#CD2C2D',
      thread: { lib: 'Metrosene', code: '0104', name: 'Candy Apple' },
      attach: true,
      sort: 'card',
    },
    picked: null, // { hex, source: 'fabric' | 'custom' }
    clipboard: null,
    editKey: null,
  });

  let idCounter = 0;
  F.uid = (prefix) => prefix + Date.now().toString(36) + (idCounter++).toString(36) + Math.random().toString(36).slice(2, 6);

  // ---- Lookups -------------------------------------------------------------

  F.clipById = (id) => S.doc.clips.find((c) => c.id === id) || null;
  F.stitchById = (id) => S.doc.stitches.find((s) => s.id === id) || null;
  F.isClipId = (id) => typeof id === 'string' && id.startsWith('c_');
  F.isStitchId = (id) => typeof id === 'string' && id.startsWith('s_');
  F.parentOf = (st) => (st.parent ? F.clipById(st.parent) : null);
  F.stitchesOf = (clipId) => S.doc.stitches.filter((s) => s.parent === clipId);

  F.selectedClips = () => S.doc.clips.filter((c) => S.sel.has(c.id));
  F.selectedStitches = () => S.doc.stitches.filter((s) => S.sel.has(s.id));
  F.linkedClips = () => S.doc.clips.filter((c) => c.linked);

  // ---- Transforms ----------------------------------------------------------

  F.toBoard = function (clip, p) {
    if (!clip) return [p[0], p[1]];
    const c = Math.cos(clip.rot), s = Math.sin(clip.rot);
    const a = p[0] * clip.scale * (clip.flip ? -1 : 1), b = p[1] * clip.scale;
    return [clip.x + c * a - s * b, clip.y + s * a + c * b];
  };

  F.toLocal = function (clip, p) {
    if (!clip) return [p[0], p[1]];
    const c = Math.cos(clip.rot), s = Math.sin(clip.rot);
    const dx = p[0] - clip.x, dy = p[1] - clip.y;
    const a = c * dx + s * dy, b = -s * dx + c * dy;
    return [a / (clip.scale * (clip.flip ? -1 : 1)), b / clip.scale];
  };

  F.toScreen = (p) => [p[0] * S.view.zoom + S.view.x, p[1] * S.view.zoom + S.view.y];
  F.screenToBoard = (p) => [(p[0] - S.view.x) / S.view.zoom, (p[1] - S.view.y) / S.view.zoom];

  F.clipCorners = function (clip) {
    const hw = clip.w / 2, hh = clip.h / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map((p) => F.toBoard(clip, p));
  };

  F.clipBounds = (clip) => G.bounds(F.clipCorners(clip));

  F.stitchBounds = function (st) {
    const par = F.parentOf(st);
    const b = G.bounds(st.pts.map((p) => F.toBoard(par, p)));
    const pad = (Math.max(st.w, st.space || 0) / 2) * (par ? par.scale : 1);
    return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
  };

  F.contentBounds = function (onlySelection) {
    let b = null;
    for (const c of S.doc.clips) if (!onlySelection || S.sel.has(c.id)) b = G.unionBounds(b, F.clipBounds(c));
    for (const s of S.doc.stitches) {
      if (!onlySelection || S.sel.has(s.id) || (s.parent && S.sel.has(s.parent))) b = G.unionBounds(b, F.stitchBounds(s));
    }
    return b;
  };

  F.clipContains = function (clip, bp) {
    const l = F.toLocal(clip, bp);
    return Math.abs(l[0]) <= clip.w / 2 && Math.abs(l[1]) <= clip.h / 2;
  };

  F.topClipAt = function (bp) {
    for (let i = S.doc.clips.length - 1; i >= 0; i--) {
      if (F.clipContains(S.doc.clips[i], bp)) return S.doc.clips[i];
    }
    return null;
  };

  // ---- Units ---------------------------------------------------------------

  // Local units per millimetre for things drawn on `clip` (null = board).
  F.unitsPerMm = function (clip) {
    if (!clip) return S.doc.pxPerCm / 10;
    if (clip.cal && clip.cal.pxPerCm > 0) return clip.cal.pxPerCm / 10;
    return S.doc.pxPerCm / 10 / clip.scale;
  };

  // ---- History -------------------------------------------------------------

  const H = (F.history = { undo: [], redo: [], limit: 150 });

  F.checkpoint = function () {
    H.undo.push(JSON.stringify(S.doc));
    if (H.undo.length > H.limit) H.undo.shift();
    H.redo.length = 0;
    S.editKey = null;
  };

  // Group a run of input events into one undo step.
  F.beginEdit = function (key) {
    if (S.editKey === key) return;
    F.checkpoint();
    S.editKey = key;
  };
  F.endEdit = () => { S.editKey = null; };

  function restore(json) {
    S.doc = JSON.parse(json);
    for (const id of [...S.sel]) if (!F.clipById(id) && !F.stitchById(id)) S.sel.delete(id);
    S.editKey = null;
    F.changed();
  }

  F.undo = function () {
    if (!H.undo.length) return;
    H.redo.push(JSON.stringify(S.doc));
    restore(H.undo.pop());
  };

  F.redo = function () {
    if (!H.redo.length) return;
    H.undo.push(JSON.stringify(S.doc));
    restore(H.redo.pop());
  };

  // ---- Change notification -------------------------------------------------

  F.changed = function () {
    S.version++;
    F.requestRender();
    F.scheduleSave();
    if (F.ui) F.ui.refresh();
  };

  F.selectionChanged = function () {
    F.requestRender();
    if (F.ui) F.ui.refresh();
  };

  F.select = function (ids, add) {
    if (!add) S.sel.clear();
    for (const id of ids) S.sel.add(id);
    F.selectionChanged();
  };

  F.clearSelection = function () {
    if (!S.sel.size) return;
    S.sel.clear();
    F.selectionChanged();
  };

  let saveTimer = null;
  let saveWarned = false;
  F.scheduleSave = function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(F.saveNow, 500);
  };
  F.saveNow = function () {
    clearTimeout(saveTimer);
    saveTimer = null;
    return F.store.save(S.doc, S.images, F.prefs()).catch((err) => {
      console.warn('Autosave failed', err);
      if (!saveWarned) {
        saveWarned = true;
        F.toast('Autosave is not available in this browser window. Use Save to keep your board.');
      }
    });
  };

  F.prefs = function () {
    const o = S.opts;
    return { kind: o.kind, kinds: o.kinds, width: o.width, color: o.color, thread: o.thread, attach: o.attach, sort: o.sort };
  };

  // ---- Images --------------------------------------------------------------

  F.loadImageRecord = async function (blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();
    return { blob, img, url, w: img.naturalWidth, h: img.naturalHeight };
  };

  // Find a spot near `pref` where a w × h box does not overlap other samples.
  function freeSpot(w, h, pref) {
    const others = S.doc.clips.map(F.clipBounds);
    const m = 10 / S.view.zoom;
    const fits = (p) => !others.some((o) => G.boundsIntersect(o, {
      minX: p[0] - w / 2 - m, maxX: p[0] + w / 2 + m, minY: p[1] - h / 2 - m, maxY: p[1] + h / 2 + m,
    }));
    if (fits(pref)) return pref;
    const sx = Math.max(w / 3, 8 / S.view.zoom), sy = Math.max(h / 3, 8 / S.view.zoom);
    for (let ring = 1; ring <= 30; ring++) {
      const cands = [];
      for (let i = -ring; i <= ring; i++) {
        for (let j = -ring; j <= ring; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) === ring) cands.push([i, j]);
        }
      }
      cands.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
      for (const [i, j] of cands) {
        const p = [pref[0] + i * sx, pref[1] + j * sy];
        if (fits(p)) return p;
      }
    }
    return pref;
  }

  // Bring a board box into view if it is off screen.
  function reveal(b) {
    const vs = F.viewSize();
    const a = F.toScreen([b.minX, b.minY]), c = F.toScreen([b.maxX, b.maxY]);
    if (a[0] >= 0 && a[1] >= 0 && c[0] <= vs.w && c[1] <= vs.h) return;
    S.view.x += vs.w / 2 - (a[0] + c[0]) / 2;
    S.view.y += vs.h / 2 - (a[1] + c[1]) / 2;
  }

  // Add image blobs as new samples. `at` = board point (drop position).
  F.addImages = async function (blobs, at) {
    const dpr = window.devicePixelRatio || 1;
    const vw = F.viewSize().w / S.view.zoom, vh = F.viewSize().h / S.view.zoom;
    const centre = F.screenToBoard([F.viewSize().w / 2, F.viewSize().h / 2]);
    const recs = [];
    for (const blob of blobs) {
      try {
        recs.push({ blob, rec: await F.loadImageRecord(blob) });
      } catch (e) {
        F.toast('Could not read that picture.');
      }
    }
    if (!recs.length) return [];

    const gap = 12 / S.view.zoom;
    const added = recs.map(({ blob, rec }) => {
      const imageId = F.uid('i_');
      S.images.set(imageId, rec);
      // Keep the on-screen size of screenshots (Retina screenshots have 2× pixels),
      // unless the picture would not fit in the window.
      let scale = 1 / dpr;
      if (rec.w * scale > vw * 0.9 || rec.h * scale > vh * 0.9) scale = Math.min((vw * 0.9) / rec.w, (vh * 0.9) / rec.h);
      let name = (blob.name || '').replace(/\.[a-z0-9]+$/i, '');
      if (!name || /^image(\s*\(\d+\))?$/i.test(name)) name = '';
      return { id: F.uid('c_'), imageId, name, x: 0, y: 0, scale, rot: 0, flip: false, w: rec.w, h: rec.h, cal: null, linked: false };
    });
    let n = S.doc.clips.length;
    for (const c of added) if (!c.name) c.name = 'Sample ' + ++n;

    // Lay the new pictures out in a row and find room for the row.
    const rowW = added.reduce((acc, c) => acc + c.w * c.scale, 0) + gap * (added.length - 1);
    const rowH = Math.max(...added.map((c) => c.h * c.scale));
    let pref = at ? at.slice() : centre;
    const last = !at && S.lastAdded && F.clipById(S.lastAdded);
    if (last) {
      // next to the previous picture, top edges lined up
      const b = F.clipBounds(last);
      pref = [b.maxX + gap + rowW / 2, b.minY + rowH / 2];
      const sp = F.toScreen(pref);
      const vs = F.viewSize();
      if (sp[0] < 0 || sp[1] < 0 || sp[0] > vs.w || sp[1] > vs.h) pref = centre;
    }
    const spot = at ? pref : freeSpot(rowW, rowH, pref);
    let x = spot[0] - rowW / 2;
    for (const c of added) {
      c.x = x + (c.w * c.scale) / 2;
      c.y = spot[1] - rowH / 2 + (c.h * c.scale) / 2;
      x += c.w * c.scale + gap;
    }

    F.checkpoint();
    S.doc.clips.push(...added);
    S.lastAdded = added[added.length - 1].id;
    S.sel = new Set(added.map((c) => c.id));
    if (S.tool !== 'select' && S.tool !== 'stitch') F.setTool('select');
    reveal(added.reduce((acc, c) => G.unionBounds(acc, F.clipBounds(c)), null));
    F.changed();
    return added;
  };

  // ---- Editing -------------------------------------------------------------

  F.deleteSelection = function () {
    if (!S.sel.size) return;
    F.checkpoint();
    const gone = new Set(S.sel);
    S.doc.clips = S.doc.clips.filter((c) => !gone.has(c.id));
    S.doc.stitches = S.doc.stitches.filter((s) => !gone.has(s.id) && !(s.parent && gone.has(s.parent)));
    S.sel.clear();
    F.changed();
  };

  function cloneItems(ids) {
    const clips = S.doc.clips.filter((c) => ids.has(c.id));
    const clipIds = new Set(clips.map((c) => c.id));
    const stitches = S.doc.stitches.filter((s) => ids.has(s.id) || (s.parent && clipIds.has(s.parent)));
    return JSON.parse(JSON.stringify({ clips, stitches }));
  }

  // Insert copies of {clips, stitches}, offset by d (board units). Returns new ids.
  function insertCopies(items, d) {
    const idMap = new Map();
    const newIds = [];
    for (const c of items.clips) {
      const nc = Object.assign({}, c, { id: F.uid('c_'), x: c.x + d[0], y: c.y + d[1] });
      idMap.set(c.id, nc.id);
      S.doc.clips.push(nc);
      newIds.push(nc.id);
    }
    for (const s of items.stitches) {
      const ns = Object.assign({}, s, { id: F.uid('s_') });
      if (s.parent && idMap.has(s.parent)) {
        ns.parent = idMap.get(s.parent);
      } else {
        const par = s.parent ? F.clipById(s.parent) : null;
        if (s.parent && !par) ns.parent = null; // parent gone: keep where it is on the board
        ns.pts = s.pts.map((p) => F.toLocal(par, G.add(F.toBoard(par, p), d)));
        newIds.push(ns.id);
      }
      S.doc.stitches.push(ns);
    }
    return newIds;
  }

  F.duplicateSelection = function (offset) {
    if (!S.sel.size) return [];
    const d = offset || [20 / S.view.zoom, 20 / S.view.zoom];
    F.checkpoint();
    const ids = insertCopies(cloneItems(S.sel), d);
    S.sel = new Set(ids);
    F.changed();
    return ids;
  };

  F.copySelection = function () {
    if (!S.sel.size) return false;
    S.clipboard = { items: cloneItems(S.sel), count: 0 };
    return true;
  };

  F.pasteInternal = function () {
    if (!S.clipboard) return;
    F.checkpoint();
    // each paste lands a bit further along
    const k = (++S.clipboard.count * 24) / S.view.zoom;
    const ids = insertCopies(S.clipboard.items, [k, k]);
    S.sel = new Set(ids);
    F.changed();
  };

  F.reorder = function (where) {
    const sel = F.selectedClips();
    if (!sel.length) return;
    F.checkpoint();
    const rest = S.doc.clips.filter((c) => !S.sel.has(c.id));
    const clips = S.doc.clips;
    if (where === 'front') S.doc.clips = rest.concat(sel);
    else if (where === 'back') S.doc.clips = sel.concat(rest);
    else {
      const arr = clips.slice();
      const dir = where === 'forward' ? 1 : -1;
      const order = dir > 0 ? [...arr.keys()].reverse() : [...arr.keys()];
      for (const i of order) {
        const j = i + dir;
        if (S.sel.has(arr[i].id) && j >= 0 && j < arr.length && !S.sel.has(arr[j].id)) {
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
      }
      S.doc.clips = arr;
    }
    F.changed();
  };

  F.rotateSelection = function (deg) {
    const clips = F.selectedClips();
    if (!clips.length) return;
    F.checkpoint();
    const b = F.contentBounds(true);
    const o = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    const a = (deg * Math.PI) / 180;
    for (const c of clips) {
      const p = G.rotScaleAbout([c.x, c.y], o, a, 1);
      c.x = p[0]; c.y = p[1];
      c.rot = normAngle(c.rot + a);
    }
    F.changed();
  };

  F.flipSelection = function () {
    const clips = F.selectedClips();
    if (!clips.length) return;
    F.checkpoint();
    for (const c of clips) c.flip = !c.flip;
    F.changed();
  };

  function normAngle(a) {
    a = a % (Math.PI * 2);
    if (a > Math.PI) a -= Math.PI * 2;
    if (a <= -Math.PI) a += Math.PI * 2;
    return a;
  }
  F.normAngle = normAngle;

  // Arrange selected samples side by side ('row') or in a grid.
  F.arrange = function (mode, withGap) {
    const clips = F.selectedClips();
    if (clips.length < 2) return;
    F.checkpoint();
    const gap = withGap ? 12 / S.view.zoom : 0;
    const items = clips.map((c) => ({ c, b: F.clipBounds(c) }));
    const all = items.reduce((acc, it) => G.unionBounds(acc, it.b), null);
    let rows;
    if (mode === 'row') {
      items.sort((a, b) => a.b.minX - b.b.minX);
      rows = [items];
    } else {
      items.sort((a, b) => (a.b.minY + a.b.maxY) / 2 - (b.b.minY + b.b.maxY) / 2);
      const cols = Math.ceil(Math.sqrt(items.length));
      rows = [];
      for (let i = 0; i < items.length; i += cols) {
        rows.push(items.slice(i, i + cols).sort((a, b) => a.b.minX - b.b.minX));
      }
    }
    let y = all.minY;
    for (const row of rows) {
      let x = all.minX;
      let rowH = 0;
      for (const it of row) {
        const w = it.b.maxX - it.b.minX, h = it.b.maxY - it.b.minY;
        it.c.x += x - it.b.minX;
        it.c.y += y - it.b.minY;
        x += w + gap;
        rowH = Math.max(rowH, h);
      }
      y += rowH + gap;
    }
    F.changed();
  };

  // ---- Real size and linking -----------------------------------------------

  // Scale clips (and the board's px/cm) by factor k around point o.
  function scaleClipsAbout(clips, o, k) {
    for (const c of clips) {
      c.x = o[0] + (c.x - o[0]) * k;
      c.y = o[1] + (c.y - o[1]) * k;
      c.scale *= k;
    }
  }

  // Set real size from a measurement. pxPerCm is in image pixels.
  F.calibrate = function (clip, pxPerCm, info) {
    F.checkpoint();
    clip.cal = Object.assign({ pxPerCm }, info || {});
    const others = F.linkedClips().filter((c) => c.id !== clip.id);
    if (others.length) {
      clip.scale = S.doc.pxPerCm / pxPerCm;
    } else {
      // First real-size sample: keep its current size and set the board scale from it.
      S.doc.pxPerCm = pxPerCm * clip.scale;
    }
    clip.linked = true;
    F.changed();
    return others.length;
  };

  F.removeCalibration = function (clip) {
    F.checkpoint();
    clip.cal = null;
    F.changed();
  };

  F.setLinked = function (clips, on) {
    F.checkpoint();
    for (const clip of clips) {
      if (on && !clip.linked && clip.cal) {
        const others = F.linkedClips().filter((c) => c.id !== clip.id);
        if (others.length) clip.scale = S.doc.pxPerCm / clip.cal.pxPerCm;
        else S.doc.pxPerCm = clip.cal.pxPerCm * clip.scale;
      }
      clip.linked = !!on;
    }
    F.changed();
  };

  // Set doc.pxPerCm from a snapshot taken at the start of a slider drag.
  F.linkScaleSnapshot = function () {
    const clips = F.linkedClips();
    const b = clips.reduce((acc, c) => G.unionBounds(acc, F.clipBounds(c)), null);
    return {
      px: S.doc.pxPerCm,
      o: b ? [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] : [0, 0],
      clips: clips.map((c) => ({ c, x: c.x, y: c.y, scale: c.scale })),
    };
  };

  F.applyLinkScale = function (snap, newPx) {
    const k = newPx / snap.px;
    for (const it of snap.clips) {
      it.c.x = snap.o[0] + (it.x - snap.o[0]) * k;
      it.c.y = snap.o[1] + (it.y - snap.o[1]) * k;
      it.c.scale = it.scale * k;
    }
    S.doc.pxPerCm = newPx;
  };

  F.scaleClipsAbout = scaleClipsAbout;

  // ---- Stitches ------------------------------------------------------------

  F.kindDefaults = (kind) => S.opts.kinds[kind] || S.opts.kinds.running;

  F.makeStitch = function (parent, pts) {
    const u = F.unitsPerMm(parent);
    const d = F.kindDefaults(S.opts.kind);
    return {
      id: F.uid('s_'),
      parent: parent ? parent.id : null,
      pts,
      kind: S.opts.kind,
      len: d.len * u,
      space: d.space * u,
      w: S.opts.width * u,
      color: S.opts.color,
      thread: S.opts.thread ? Object.assign({}, S.opts.thread) : null,
    };
  };

  // mm value of a stitch property
  F.stitchMm = (st, prop) => st[prop] / F.unitsPerMm(F.parentOf(st));

  F.setTool = function (tool) {
    S.tool = tool;
    if (F.input) F.input.toolChanged();
    F.requestRender();
    if (F.ui) F.ui.refresh();
  };
})(window.Fabrica = window.Fabrica || {});
