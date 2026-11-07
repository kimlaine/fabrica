// Pointer, wheel, keyboard, clipboard and drag-and-drop handling; the tools.
(function (F) {
  'use strict';

  const S = F.state;
  const G = F.geom;
  const I = (F.input = {
    op: null,
    hoverId: null,
    preview: null, // { parent, stitch } while drawing
    guides: [],
    measure: null, // { a, b, label } board points
    loupe: null, // { sp, hex }
    tip: null, // { sp, text }
    spaceDown: false,
  });
  const CLIP_MARK = 'fabrica-clipboard:';
  let canvas = null;
  let lastSp = [0, 0];

  // ---- View ----------------------------------------------------------------

  F.zoomTo = function (z, sp) {
    z = Math.max(0.03, Math.min(32, z));
    const vs = F.viewSize();
    sp = sp || [vs.w / 2, vs.h / 2];
    const b = F.screenToBoard(sp);
    S.view.zoom = z;
    S.view.x = sp[0] - b[0] * z;
    S.view.y = sp[1] - b[1] * z;
    F.requestRender();
    if (F.ui) F.ui.refreshZoom();
  };

  F.zoomBy = (k, sp) => F.zoomTo(S.view.zoom * k, sp);

  F.fitView = function (onlySelection) {
    const vs = F.viewSize();
    const b = F.contentBounds(onlySelection && S.sel.size > 0);
    if (!b) {
      S.view.zoom = 1;
      S.view.x = vs.w / 2;
      S.view.y = vs.h / 2;
    } else {
      const bw = Math.max(b.maxX - b.minX, 1), bh = Math.max(b.maxY - b.minY, 1);
      const z = Math.max(0.03, Math.min(4, Math.min((vs.w * 0.86) / bw, (vs.h * 0.86) / bh)));
      S.view.zoom = z;
      S.view.x = vs.w / 2 - ((b.minX + b.maxX) / 2) * z;
      S.view.y = vs.h / 2 - ((b.minY + b.maxY) / 2) * z;
    }
    F.requestRender();
    if (F.ui) F.ui.refreshZoom();
  };

  // ---- Setup ---------------------------------------------------------------

  I.init = function (cv) {
    canvas = cv;
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onCancel);
    cv.addEventListener('pointerleave', () => {
      if (I.op) return;
      I.hoverId = null;
      I.loupe = null;
      F.requestRender();
    });
    cv.addEventListener('dblclick', onDblClick);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      I.gesture = { zoom: S.view.zoom };
    });
    cv.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      if (I.gesture) F.zoomTo(I.gesture.zoom * e.scale, screenPt(e));
    });
    cv.addEventListener('gestureend', (e) => {
      e.preventDefault();
      I.gesture = null;
    });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('paste', onPaste);
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    window.addEventListener('blur', () => {
      I.spaceDown = false;
      updateCursor();
    });

    const stage = cv.parentElement;
    stage.addEventListener('dragover', (e) => {
      if (!hasDroppable(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      stage.classList.add('drop-target');
    });
    stage.addEventListener('dragleave', (e) => {
      if (!stage.contains(e.relatedTarget)) stage.classList.remove('drop-target');
    });
    stage.addEventListener('drop', onDrop);
  };

  I.toolChanged = function () {
    if (I.op && I.op.type !== 'pan') cancelOp();
    I.preview = null;
    I.loupe = null;
    I.hoverId = null;
    I.tip = null;
    if (F.ui && F.ui.closeMeasure) F.ui.closeMeasure();
    updateCursor();
  };

  function capture(e) {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) { /* pointer already gone */ }
  }

  function screenPt(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // ---- Hit testing ---------------------------------------------------------

  function hitStitch(st, bp) {
    const par = F.parentOf(st);
    if (st.parent && !par) return false;
    const lp = F.toLocal(par, bp);
    const k = S.view.zoom * (par ? par.scale : 1); // screen px per local unit
    let reach = st.w / 2;
    if (st.kind === 'zigzag') reach += st.space / 2;
    if (st.kind === 'blanket') reach += st.space;
    if (st.kind === 'cross') reach += st.len * 0.46;
    return G.distToPolyline(lp, st.pts) <= reach + 5 / k;
  }

  // Top-most stitch under the point (free stitches are drawn last).
  function hitAnyStitch(bp) {
    const sts = S.doc.stitches;
    for (let i = sts.length - 1; i >= 0; i--) if (!sts[i].parent && hitStitch(sts[i], bp)) return sts[i].id;
    for (let ci = S.doc.clips.length - 1; ci >= 0; ci--) {
      const id = S.doc.clips[ci].id;
      for (let i = sts.length - 1; i >= 0; i--) if (sts[i].parent === id && hitStitch(sts[i], bp)) return sts[i].id;
    }
    return null;
  }

  // What the Select tool grabs: selected stitches, free stitches, samples,
  // then stitches sticking out past their sample.
  function hitSelect(bp) {
    for (const st of F.selectedStitches()) if (hitStitch(st, bp)) return st.id;
    const sts = S.doc.stitches;
    for (let i = sts.length - 1; i >= 0; i--) if (!sts[i].parent && hitStitch(sts[i], bp)) return sts[i].id;
    const clip = F.topClipAt(bp);
    if (clip) return clip.id;
    return hitAnyStitch(bp);
  }

  function handleAt(fr, sp) {
    const h = F.frameHandles(fr);
    if (G.dist(sp, h.rot) <= 9) return { type: 'rotate' };
    for (let i = 0; i < 4; i++) {
      const p = h.corners[i];
      if (Math.abs(sp[0] - p[0]) <= 7 && Math.abs(sp[1] - p[1]) <= 7) return { type: 'scale', index: i };
    }
    return null;
  }

  function inFrame(fr, bp) {
    const l = G.rot(G.sub(bp, [fr.cx, fr.cy]), -fr.angle);
    return Math.abs(l[0]) <= fr.hw && Math.abs(l[1]) <= fr.hh;
  }

  // ---- Snapshots for transforms -------------------------------------------

  function makeSnap(withLinked) {
    const clipIds = new Set(F.selectedClips().map((c) => c.id));
    if (withLinked) F.linkedClips().forEach((c) => clipIds.add(c.id));
    const snap = { clips: [], stitches: [] };
    for (const c of S.doc.clips) {
      if (clipIds.has(c.id)) snap.clips.push({ c, x: c.x, y: c.y, scale: c.scale, rot: c.rot, rotates: S.sel.has(c.id) });
    }
    for (const st of F.selectedStitches()) {
      if (st.parent && clipIds.has(st.parent)) continue;
      snap.stitches.push({ st, pts: st.pts, len: st.len, space: st.space, w: st.w });
    }
    return snap;
  }

  function applySnap(snap, fn, k, dRot) {
    for (const it of snap.clips) {
      const p = fn([it.x, it.y]);
      it.c.x = p[0];
      it.c.y = p[1];
      it.c.scale = it.scale * k;
      if (it.rotates) it.c.rot = F.normAngle(it.rot + dRot);
    }
    for (const it of snap.stitches) {
      const par = F.parentOf(it.st);
      it.st.pts = it.pts.map((p) => F.toLocal(par, fn(F.toBoard(par, p))));
      it.st.len = it.len * k;
      it.st.space = it.space * k;
      it.st.w = it.w * k;
    }
  }

  // ---- Pointer -------------------------------------------------------------

  function onDown(e) {
    if (I.op) return;
    const sp = screenPt(e), bp = F.screenToBoard(sp);
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae.blur) ae.blur();
    if (F.ui && F.ui.measureOpen && F.ui.measureOpen()) F.ui.closeMeasure();

    if (e.button === 1 || e.button === 2 || (e.button === 0 && (I.spaceDown || S.tool === 'pan'))) {
      capture(e);
      I.op = { type: 'pan', last: sp };
      updateCursor();
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    capture(e);
    const tool = S.tool === 'stitch' && e.altKey ? 'pick' : S.tool;
    if (tool === 'select') selectDown(e, sp, bp);
    else if (tool === 'stitch') stitchDown(e, sp, bp);
    else if (tool === 'pick') pickMove(e, sp, bp, true);
    else if (tool === 'measure') measureDown(e, sp, bp);
  }

  function onMove(e) {
    const sp = screenPt(e), bp = F.screenToBoard(sp);
    lastSp = sp;
    const op = I.op;
    if (!op) return hover(e, sp, bp);
    switch (op.type) {
      case 'pan':
        S.view.x += sp[0] - op.last[0];
        S.view.y += sp[1] - op.last[1];
        op.last = sp;
        F.requestRender();
        break;
      case 'move': moveMove(e, sp, bp); break;
      case 'scale': scaleMove(e, sp, bp); break;
      case 'rotate': rotateMove(e, sp, bp); break;
      case 'marquee': marqueeMove(e, sp, bp); break;
      case 'stitch': stitchMove(e, sp, bp); break;
      case 'pick': pickMove(e, sp, bp, false); break;
      case 'measure': measureMove(e, sp, bp); break;
    }
  }

  function onUp(e) {
    const op = I.op;
    if (!op) return;
    const sp = screenPt(e), bp = F.screenToBoard(sp);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (err) { /* already released */ }
    I.op = null;
    I.guides = [];
    I.tip = null;
    if (op.type === 'stitch') stitchUp(e, op, sp, bp);
    else if (op.type === 'pick') pickUp(op);
    else if (op.type === 'measure') measureUp(op, sp);
    else if (op.type === 'move' && !op.started && !e.shiftKey && op.clickId) {
      // plain click on an item in a multi-selection selects just that item
      F.select([op.clickId]);
    }
    if (op.started) F.changed();
    F.requestRender();
    hover(e, sp, bp);
  }

  function onCancel() {
    cancelOp();
  }

  function cancelOp() {
    const op = I.op;
    I.op = null;
    I.preview = null;
    I.guides = [];
    I.tip = null;
    if (op && op.started && op.type !== 'pan') F.undo();
    if (op && op.type === 'measure') I.measure = null;
    F.requestRender();
  }

  function onDblClick(e) {
    if (S.tool !== 'select') return;
    const id = hitAnyStitch(F.screenToBoard(screenPt(e)));
    if (id) F.select([id]);
  }

  function hover(e, sp, bp) {
    let id = null;
    if (!I.spaceDown) {
      if (S.tool === 'select') id = hitSelect(bp);
      else if ((S.tool === 'stitch' && S.opts.attach) || S.tool === 'measure') {
        const c = F.topClipAt(bp);
        id = c ? c.id : null;
      }
    }
    if (id !== I.hoverId) {
      I.hoverId = id;
      F.requestRender();
    }
    if (S.tool === 'pick' || (S.tool === 'stitch' && e.altKey)) {
      I.loupe = { sp, hex: sampleAt(bp) };
      F.requestRender();
    } else if (I.loupe) {
      I.loupe = null;
      F.requestRender();
    }
    updateCursor(sp, bp);
  }

  function updateCursor(sp, bp) {
    if (!canvas) return;
    sp = sp || lastSp;
    bp = bp || F.screenToBoard(sp);
    let cur = 'default';
    if (I.op && I.op.type === 'pan') cur = 'grabbing';
    else if (I.spaceDown || S.tool === 'pan') cur = 'grab';
    else if (S.tool === 'stitch' || S.tool === 'measure' || S.tool === 'pick') cur = 'crosshair';
    else if (I.op && I.op.type === 'rotate') cur = 'grabbing';
    else if (I.op && I.op.type === 'move') cur = 'move';
    else {
      const fr = F.selectionFrame();
      const h = fr && handleAt(fr, sp);
      if (h) cur = h.type === 'rotate' ? 'grab' : cornerCursor(fr, h.index);
      else if (hitSelect(bp) || (fr && S.sel.size > 1 && inFrame(fr, bp))) cur = 'move';
    }
    canvas.style.cursor = cur;
  }

  function cornerCursor(fr, idx) {
    const c = F.frameCorners(fr)[idx];
    let a = (Math.atan2(c[1] - fr.cy, c[0] - fr.cx) * 180) / Math.PI;
    a = ((a % 180) + 180) % 180;
    return a < 90 ? 'nwse-resize' : 'nesw-resize';
  }

  // ---- Select tool ---------------------------------------------------------

  function selectDown(e, sp, bp) {
    const fr = F.selectionFrame();
    if (fr) {
      const h = handleAt(fr, sp);
      if (h && h.type === 'rotate') {
        I.op = { type: 'rotate', fr, c: [fr.cx, fr.cy], a0: Math.atan2(bp[1] - fr.cy, bp[0] - fr.cx), started: false };
        return;
      }
      if (h) {
        const corners = F.frameCorners(fr);
        const linked = F.selectedClips().some((c) => c.linked);
        I.op = {
          type: 'scale', fr, handle: corners[h.index], opposite: corners[(h.index + 2) % 4],
          c: [fr.cx, fr.cy], started: false, linked, px0: S.doc.pxPerCm,
        };
        return;
      }
    }
    const id = hitSelect(bp);
    if (id) {
      let clickId = null;
      if (e.shiftKey) {
        if (S.sel.has(id)) {
          S.sel.delete(id);
          F.selectionChanged();
          return;
        }
        F.select([id], true);
      } else if (!S.sel.has(id)) {
        F.select([id]);
      } else if (S.sel.size > 1) {
        clickId = id;
      }
      I.op = { type: 'move', start: bp, startSp: sp, started: false, alt: e.altKey, clickId };
      return;
    }
    if (fr && S.sel.size > 1 && inFrame(fr, bp)) {
      I.op = { type: 'move', start: bp, startSp: sp, started: false, alt: e.altKey };
      return;
    }
    I.op = { type: 'marquee', start: bp, base: e.shiftKey ? new Set(S.sel) : new Set(), rect: null };
    if (!e.shiftKey) F.clearSelection();
  }

  function moveMove(e, sp, bp) {
    const op = I.op;
    if (!op.started) {
      if (G.dist(sp, op.startSp) < 3) return;
      op.started = true;
      if (op.alt) F.duplicateSelection([0, 0]);
      else F.checkpoint();
      op.snap = makeSnap(false);
      const moving = new Set(op.snap.clips.map((it) => it.c.id));
      op.box = op.snap.clips.reduce((acc, it) => G.unionBounds(acc, F.clipBounds(it.c)), null);
      op.others = S.doc.clips.filter((c) => !moving.has(c.id)).map(F.clipBounds);
    }
    let d = G.sub(bp, op.start);
    I.guides = [];
    if (op.box && !(e.metaKey || e.ctrlKey)) d = snapMove(op, d);
    applySnap(op.snap, (p) => G.add(p, d), 1, 0);
    F.changed();
  }

  function snapMove(op, d) {
    const thr = 7 / S.view.zoom;
    const b = op.box;
    const box = { minX: b.minX + d[0], maxX: b.maxX + d[0], minY: b.minY + d[1], maxY: b.maxY + d[1] };
    let bx = null, by = null;
    const pairs = [[0, 0], [0, 2], [2, 0], [2, 2], [1, 1]];
    const xs = [box.minX, (box.minX + box.maxX) / 2, box.maxX];
    const ys = [box.minY, (box.minY + box.maxY) / 2, box.maxY];
    for (const o of op.others) {
      const oxs = [o.minX, (o.minX + o.maxX) / 2, o.maxX];
      const oys = [o.minY, (o.minY + o.maxY) / 2, o.maxY];
      for (const [i, j] of pairs) {
        const dx = oxs[j] - xs[i];
        if (Math.abs(dx) < thr && (!bx || Math.abs(dx) < Math.abs(bx.d))) bx = { d: dx, v: oxs[j], o };
        const dy = oys[j] - ys[i];
        if (Math.abs(dy) < thr && (!by || Math.abs(dy) < Math.abs(by.d))) by = { d: dy, v: oys[j], o };
      }
    }
    const nd = [d[0] + (bx ? bx.d : 0), d[1] + (by ? by.d : 0)];
    const fb = { minX: b.minX + nd[0], maxX: b.maxX + nd[0], minY: b.minY + nd[1], maxY: b.maxY + nd[1] };
    if (bx) I.guides.push([[bx.v, Math.min(fb.minY, bx.o.minY)], [bx.v, Math.max(fb.maxY, bx.o.maxY)]]);
    if (by) I.guides.push([[Math.min(fb.minX, by.o.minX), by.v], [Math.max(fb.maxX, by.o.maxX), by.v]]);
    return nd;
  }

  function scaleMove(e, sp, bp) {
    const op = I.op;
    if (!op.started) {
      op.started = true;
      F.checkpoint();
      op.snap = makeSnap(op.linked);
    }
    const pivot = e.altKey ? op.c : op.opposite;
    const ref = G.sub(op.handle, pivot);
    const k = Math.max(0.02, G.dot(G.sub(bp, pivot), ref) / Math.max(G.dot(ref, ref), 1e-9));
    applySnap(op.snap, (p) => G.add(pivot, G.mul(G.sub(p, pivot), k)), k, 0);
    if (op.linked) S.doc.pxPerCm = op.px0 * k;
    const one = op.snap.clips.length === 1 && !op.snap.stitches.length ? op.snap.clips[0].c : null;
    let text = Math.round(k * 100) + '%';
    if (one) text = Math.round(one.scale * 100) + '%';
    if (op.linked) text = 'Linked · 1 cm = ' + S.doc.pxPerCm.toFixed(1) + ' px';
    I.tip = { sp, text };
    F.changed();
  }

  function rotateMove(e, sp, bp) {
    const op = I.op;
    if (!op.started) {
      op.started = true;
      F.checkpoint();
      op.snap = makeSnap(false);
    }
    let da = Math.atan2(bp[1] - op.c[1], bp[0] - op.c[0]) - op.a0;
    const step = Math.PI / 12;
    if (e.shiftKey) da = Math.round((op.fr.angle + da) / step) * step - op.fr.angle;
    applySnap(op.snap, (p) => G.rotScaleAbout(p, op.c, da, 1), 1, da);
    let deg = Math.round(((F.normAngle(op.fr.angle + da) * 180) / Math.PI) * 10) / 10;
    if (S.sel.size > 1) deg = Math.round(((F.normAngle(da) * 180) / Math.PI) * 10) / 10;
    I.tip = { sp, text: deg + '°' };
    F.changed();
  }

  function marqueeMove(e, sp, bp) {
    const op = I.op;
    op.rect = G.bounds([op.start, bp]);
    const sel = new Set(op.base);
    for (const c of S.doc.clips) if (G.boundsIntersect(F.clipBounds(c), op.rect)) sel.add(c.id);
    for (const st of S.doc.stitches) if (!st.parent && G.boundsIntersect(F.stitchBounds(st), op.rect)) sel.add(st.id);
    S.sel = sel;
    F.selectionChanged();
  }

  // ---- Stitch tool ---------------------------------------------------------

  function stitchDown(e, sp, bp) {
    const parent = S.opts.attach ? F.topClipAt(bp) : null;
    I.op = { type: 'stitch', parent, pts: [bp], lastSp: sp, startSp: sp, end: bp, straight: e.shiftKey };
    I.preview = { parent, stitch: F.makeStitch(parent, [F.toLocal(parent, bp)]) };
  }

  function stitchPoints(op) {
    return op.straight ? [op.pts[0], op.end] : op.pts.concat([op.end]);
  }

  function stitchMove(e, sp, bp) {
    const op = I.op;
    op.straight = e.shiftKey;
    op.end = bp;
    if (!e.shiftKey && G.dist(sp, op.lastSp) >= 2) {
      op.pts.push(bp);
      op.lastSp = sp;
    }
    I.preview.stitch.pts = stitchPoints(op).map((p) => F.toLocal(op.parent, p));
    F.requestRender();
  }

  function stitchUp(e, op, sp, bp) {
    op.end = bp;
    I.preview = null;
    const pts = stitchPoints(op);
    if (G.length(pts) * S.view.zoom < 4) {
      // a click: select the stitch under the pointer
      const id = hitAnyStitch(bp);
      if (id) F.select([id], e.shiftKey);
      else if (!e.shiftKey) F.clearSelection();
      return;
    }
    const par = op.parent;
    let local = pts.map((p) => F.toLocal(par, p));
    if (!op.straight) {
      const unit = 1 / (S.view.zoom * (par ? par.scale : 1));
      local = G.smooth(G.simplify(local, 1.2 * unit), 2);
    }
    local = local.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
    F.checkpoint();
    const st = F.makeStitch(par, local);
    S.doc.stitches.push(st);
    S.sel = new Set([st.id]);
    F.changed();
  }

  // ---- Colour picker -------------------------------------------------------

  let sampleCanvas = null, sampleCtx = null;

  function sampleAt(bp) {
    const clip = F.topClipAt(bp);
    if (!clip) return F.color.normHex(S.doc.bg);
    const rec = S.images.get(clip.imageId);
    if (!rec) return F.color.normHex(S.doc.bg);
    const l = F.toLocal(clip, bp);
    const ix = Math.floor(l[0] + clip.w / 2), iy = Math.floor(l[1] + clip.h / 2);
    const r = Math.max(0, Math.min(20, Math.round(3 / (S.view.zoom * clip.scale))));
    const n = r * 2 + 1;
    if (!sampleCanvas) {
      sampleCanvas = document.createElement('canvas');
      sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (sampleCanvas.width !== n) {
      sampleCanvas.width = n;
      sampleCanvas.height = n;
    }
    sampleCtx.clearRect(0, 0, n, n);
    sampleCtx.drawImage(rec.img, ix - r, iy - r, n, n, 0, 0, n, n);
    const d = sampleCtx.getImageData(0, 0, n, n).data;
    let R = 0, Gs = 0, B = 0, A = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      R += d[i] * a;
      Gs += d[i + 1] * a;
      B += d[i + 2] * a;
      A += a;
    }
    if (A < 0.01) return F.color.normHex(S.doc.bg);
    return F.color.rgbToHex(R / A, Gs / A, B / A);
  }
  I.sampleAt = sampleAt;

  function pickMove(e, sp, bp, first) {
    if (first) I.op = { type: 'pick' };
    const hex = sampleAt(bp);
    I.op.hex = hex;
    I.loupe = { sp, hex };
    F.requestRender();
  }

  function pickUp(op) {
    if (op.hex && F.ui) F.ui.setPicked(op.hex, 'fabric');
  }

  // ---- Measure tool --------------------------------------------------------

  function measureDown(e, sp, bp) {
    const clip = F.topClipAt(bp);
    if (!clip) {
      F.toast('Start the measuring line on a sample.');
      return;
    }
    if (!S.sel.has(clip.id) || S.sel.size > 1) F.select([clip.id]);
    I.op = { type: 'measure', clip, a: bp, startSp: sp };
    I.measure = { a: bp, b: bp, label: '' };
  }

  function measureMove(e, sp, bp) {
    const op = I.op;
    let b = bp;
    if (e.shiftKey) {
      const d = G.sub(bp, op.a);
      const ang = Math.round(Math.atan2(d[1], d[0]) / (Math.PI / 4)) * (Math.PI / 4);
      const L = Math.hypot(d[0], d[1]);
      b = [op.a[0] + Math.cos(ang) * L, op.a[1] + Math.sin(ang) * L];
    }
    I.measure.b = b;
    F.requestRender();
  }

  function measureUp(op, sp) {
    const m = I.measure;
    if (!m || G.dist(F.toScreen(m.a), F.toScreen(m.b)) < 6) {
      I.measure = null;
      F.toast('Drag across something whose real size you know, e.g. a ruler or one pattern repeat.');
      return;
    }
    const la = F.toLocal(op.clip, m.a), lb = F.toLocal(op.clip, m.b);
    m.label = '?';
    const mid = F.toScreen([(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2]);
    F.ui.askMeasure(op.clip, la, lb, mid);
  }

  // ---- Wheel ---------------------------------------------------------------

  function onWheel(e) {
    e.preventDefault();
    const sp = screenPt(e);
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    else if (e.deltaMode === 2) { dx *= F.viewSize().w; dy *= F.viewSize().h; }
    if (e.ctrlKey || e.metaKey) {
      if (I.gesture) return;
      const step = Math.max(-60, Math.min(60, dy));
      F.zoomTo(S.view.zoom * Math.exp(-step * 0.0085), sp);
    } else {
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      S.view.x -= dx;
      S.view.y -= dy;
      F.requestRender();
    }
  }

  // ---- Keyboard ------------------------------------------------------------

  function isTextField(t) {
    if (!t || !t.tagName) return false;
    if (t.isContentEditable || t.tagName === 'TEXTAREA') return true;
    if (t.tagName !== 'INPUT') return false;
    return !['range', 'checkbox', 'radio', 'button', 'color', 'submit', 'file'].includes(t.type);
  }

  function isControl(t) {
    if (!t || !t.tagName) return false;
    return t.tagName === 'SELECT' || t.tagName === 'BUTTON' || (t.tagName === 'INPUT' && !isTextField(t));
  }

  function onKeyDown(e) {
    const t = e.target;
    if (isTextField(t)) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    const mod = e.metaKey || e.ctrlKey;
    const navKey = /^(arrow|enter| )/.test(k) || k === 'spacebar';
    if (isControl(t) && navKey && !mod) return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (!I.spaceDown) {
        I.spaceDown = true;
        updateCursor();
      }
      return;
    }

    if (mod) {
      let handled = true;
      if (k === 'z' && !e.shiftKey) { if (!I.op) F.undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { if (!I.op) F.redo(); }
      else if (k === 'd') F.duplicateSelection();
      else if (k === 'a') F.select(S.doc.clips.map((c) => c.id).concat(S.doc.stitches.filter((s) => !s.parent).map((s) => s.id)));
      else if (k === 's') F.ui.saveFile();
      else if (k === 'o') F.ui.openFile();
      else if (k === 'e') F.ui.exportPng();
      else if (k === '0') F.zoomTo(1);
      else if (k === '=' || k === '+') F.zoomBy(1.25);
      else if (k === '-') F.zoomBy(0.8);
      else handled = false;
      if (handled) e.preventDefault();
      return;
    }
    if (e.altKey && S.tool === 'stitch') {
      I.loupe = { sp: lastSp, hex: sampleAt(F.screenToBoard(lastSp)) };
      F.requestRender();
    }

    if (e.shiftKey && e.code === 'Digit1') { F.fitView(false); return; }
    if (e.shiftKey && e.code === 'Digit2') { F.fitView(true); return; }
    if (e.code === 'BracketLeft') { F.reorder(e.shiftKey ? 'back' : 'backward'); return; }
    if (e.code === 'BracketRight') { F.reorder(e.shiftKey ? 'front' : 'forward'); return; }

    switch (k) {
      case 'v': F.setTool('select'); break;
      case 's': F.setTool('stitch'); break;
      case 'i': F.setTool('pick'); break;
      case 'm': F.setTool('measure'); break;
      case 'h': F.setTool('pan'); break;
      case '?': F.ui.showHelp(); break;
      case 'delete':
      case 'backspace':
        e.preventDefault();
        if (!I.op) F.deleteSelection();
        break;
      case 'escape':
        if (I.op) cancelOp();
        else if (F.ui.measureOpen()) F.ui.closeMeasure();
        else F.clearSelection();
        break;
      case 'arrowleft':
      case 'arrowright':
      case 'arrowup':
      case 'arrowdown': {
        if (!S.sel.size || I.op) break;
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) / S.view.zoom;
        const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k];
        F.beginEdit('nudge');
        applySnap(makeSnap(false), (p) => G.add(p, d), 1, 0);
        F.changed();
        break;
      }
    }
  }

  function onKeyUp(e) {
    if (e.code === 'Space') {
      I.spaceDown = false;
      updateCursor();
    }
    if (/^Arrow/.test(e.key)) F.endEdit();
    if (e.key === 'Alt' && S.tool === 'stitch' && I.loupe && !(I.op && I.op.type === 'pick')) {
      I.loupe = null;
      F.requestRender();
    }
  }

  // ---- Clipboard and drag-and-drop -----------------------------------------

  function imageFiles(dt) {
    const files = [];
    for (const item of dt.items || []) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) for (const f of dt.files || []) if (f.type.startsWith('image/')) files.push(f);
    return files;
  }

  function imageUrlFrom(dt) {
    const html = dt.getData('text/html');
    if (html) {
      const img = new DOMParser().parseFromString(html, 'text/html').querySelector('img[src]');
      const src = img && img.getAttribute('src');
      if (src && /^(https?:|data:image\/)/i.test(src)) return src;
    }
    const uri = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim().split(/\s+/)[0];
    if (/^https?:\/\/\S+$/i.test(uri) || /^data:image\//i.test(uri)) return uri;
    return null;
  }

  async function addFromUrl(url, at) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) throw new Error('not an image');
      await F.addImages([blob], at);
    } catch (err) {
      F.toast('That website does not allow copying its picture like this. Right-click the picture → Copy Image, or take a screenshot instead.', 6000);
    }
  }

  function onPaste(e) {
    if (isTextField(e.target)) return;
    const dt = e.clipboardData;
    if (!dt) return;
    e.preventDefault();
    const files = imageFiles(dt);
    if (files.length) {
      F.addImages(files);
      return;
    }
    const text = dt.getData('text/plain') || '';
    if (text.startsWith(CLIP_MARK)) {
      if (S.clipboard) F.pasteInternal();
      return;
    }
    const url = imageUrlFrom(dt);
    if (url) return addFromUrl(url);
    F.toast('There is no picture on the clipboard. Take a screenshot to the clipboard (⌘⇧⌃4 on a Mac), or right-click a picture → Copy Image.', 6000);
  }

  function onCopy(e) {
    if (isTextField(e.target)) return;
    const s = window.getSelection && window.getSelection();
    if (s && String(s).length) return;
    if (!F.copySelection()) return;
    e.clipboardData.setData('text/plain', CLIP_MARK + Date.now());
    e.preventDefault();
  }

  function onCut(e) {
    if (isTextField(e.target)) return;
    if (!F.copySelection()) return;
    e.clipboardData.setData('text/plain', CLIP_MARK + Date.now());
    e.preventDefault();
    F.deleteSelection();
  }

  function hasDroppable(e) {
    const types = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
    return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html');
  }

  function onDrop(e) {
    e.preventDefault();
    canvas.parentElement.classList.remove('drop-target');
    const bp = F.screenToBoard(screenPt(e));
    const files = imageFiles(e.dataTransfer);
    if (files.length) {
      F.addImages(files, bp);
      return;
    }
    const url = imageUrlFrom(e.dataTransfer);
    if (url) addFromUrl(url, bp);
  }
})(window.Fabrica = window.Fabrica || {});
