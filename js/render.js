// Canvas rendering: board, samples, stitches, overlays, export.
(function (F) {
  'use strict';

  const S = F.state;
  const G = F.geom;
  const R = (F.render = {});
  const ACCENT = '#2F6FED';

  let canvas = null, ctx = null, pending = false, dpr = 1;
  let size = { w: 1, h: 1 };

  F.viewSize = () => size;

  R.init = function (cv) {
    canvas = cv;
    ctx = cv.getContext('2d');
    R.resize();
    new ResizeObserver(R.resize).observe(cv.parentElement);
    window.addEventListener('resize', R.resize); // also catches devicePixelRatio changes
  };

  R.resize = function () {
    if (!canvas) return;
    const r = canvas.parentElement.getBoundingClientRect();
    const old = size;
    dpr = window.devicePixelRatio || 1;
    size = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    canvas.style.width = size.w + 'px';
    canvas.style.height = size.h + 'px';
    // keep the board centred when the window changes size
    if (old.w > 1) {
      S.view.x += (size.w - old.w) / 2;
      S.view.y += (size.h - old.h) / 2;
    }
    draw();
  };

  F.requestRender = function () {
    if (pending || !canvas) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      draw();
    });
  };

  function draw() {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    F.drawScene(ctx, { zoom: S.view.zoom, x: S.view.x, y: S.view.y, dpr, w: size.w, h: size.h }, { overlays: true });
  }

  // ---- Scene ---------------------------------------------------------------

  function setT(c, V, clip) {
    const k = V.dpr * V.zoom;
    c.setTransform(k, 0, 0, k, V.dpr * V.x, V.dpr * V.y);
    if (clip) {
      c.translate(clip.x, clip.y);
      c.rotate(clip.rot);
      c.scale(clip.scale * (clip.flip ? -1 : 1), clip.scale);
    }
  }

  const SHADOW = [0.29, 0.96];
  function stitchOpts(V, clip) {
    let d = SHADOW;
    if (clip) {
      d = G.rot(SHADOW, -clip.rot);
      if (clip.flip) d = [-d[0], d[1]];
    }
    return { pxPerUnit: V.dpr * V.zoom * (clip ? clip.scale : 1), shadowDir: d };
  }

  function drawGrid(c, V) {
    const cm = S.doc.pxPerCm;
    if (!(cm > 0)) return;
    let step = 1;
    for (const m of [1, 5, 10, 50, 100, 500]) {
      step = m;
      if (cm * m * V.zoom >= 9) break;
    }
    const major = step < 10 ? 10 : step * 10;
    const sp = cm * step;
    const dark = F.color.isDark(S.doc.bg);
    const minor = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
    const majorC = dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.13)';
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.lineWidth = 1;
    const bx0 = -V.x / V.zoom, bx1 = (V.w - V.x) / V.zoom;
    const by0 = -V.y / V.zoom, by1 = (V.h - V.y) / V.zoom;
    for (const pass of [0, 1]) {
      c.strokeStyle = pass ? majorC : minor;
      c.beginPath();
      for (let k = Math.ceil(bx0 / sp); k <= Math.floor(bx1 / sp); k++) {
        const isMajor = Math.round(k * step) % major === 0;
        if (isMajor !== !!pass) continue;
        const x = Math.round((k * sp * V.zoom + V.x) * V.dpr) + 0.5;
        c.moveTo(x, 0);
        c.lineTo(x, V.h * V.dpr);
      }
      for (let k = Math.ceil(by0 / sp); k <= Math.floor(by1 / sp); k++) {
        const isMajor = Math.round(k * step) % major === 0;
        if (isMajor !== !!pass) continue;
        const y = Math.round((k * sp * V.zoom + V.y) * V.dpr) + 0.5;
        c.moveTo(0, y);
        c.lineTo(V.w * V.dpr, y);
      }
      c.stroke();
    }
  }

  // V: { zoom, x, y, dpr, w, h }; o: { overlays, only: Set | null }
  F.drawScene = function (c, V, o) {
    const doc = S.doc;
    const only = o.only || null;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = doc.bg;
    c.fillRect(0, 0, V.w * V.dpr, V.h * V.dpr);
    if (doc.grid) drawGrid(c, V);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';

    const clips = only ? doc.clips.filter((cl) => only.has(cl.id)) : doc.clips;
    for (const clip of clips) {
      setT(c, V, clip);
      const rec = S.images.get(clip.imageId);
      if (doc.shadows) {
        c.shadowColor = 'rgba(40,30,20,0.28)';
        c.shadowBlur = 7 * V.dpr;
        c.shadowOffsetY = 2 * V.dpr;
      }
      if (rec) {
        c.drawImage(rec.img, -clip.w / 2, -clip.h / 2, clip.w, clip.h);
      } else {
        c.fillStyle = '#ccc';
        c.fillRect(-clip.w / 2, -clip.h / 2, clip.w, clip.h);
      }
      c.shadowColor = 'transparent';
      c.shadowBlur = 0;
      c.shadowOffsetY = 0;
    }

    const byParent = new Map();
    const free = [];
    for (const st of doc.stitches) {
      if (only && !only.has(st.id) && !(st.parent && only.has(st.parent))) continue;
      if (!st.parent) free.push(st);
      else {
        if (!byParent.has(st.parent)) byParent.set(st.parent, []);
        byParent.get(st.parent).push(st);
      }
    }
    for (const clip of doc.clips) {
      const list = byParent.get(clip.id);
      if (!list) continue;
      setT(c, V, clip);
      const so = stitchOpts(V, clip);
      for (const st of list) F.stitchRender.draw(c, st, so);
    }
    if (free.length) {
      setT(c, V, null);
      const so = stitchOpts(V, null);
      for (const st of free) F.stitchRender.draw(c, st, so);
    }

    const pv = o.overlays && F.input && F.input.preview;
    if (pv && pv.stitch.pts.length > 1) {
      setT(c, V, pv.parent);
      F.stitchRender.draw(c, pv.stitch, Object.assign(stitchOpts(V, pv.parent), { alpha: 0.92 }));
    }
    c.restore();

    if (o.overlays) drawOverlays(c, V);
  };

  // ---- Selection frame -----------------------------------------------------

  // Box around the selection: oriented for a single sample, axis-aligned otherwise.
  F.selectionFrame = function () {
    if (!S.sel.size) return null;
    const clips = F.selectedClips();
    const sts = F.selectedStitches().filter((s) => !(s.parent && S.sel.has(s.parent)));
    if (clips.length === 1 && !sts.length) {
      const cl = clips[0];
      return { cx: cl.x, cy: cl.y, hw: (cl.w * cl.scale) / 2, hh: (cl.h * cl.scale) / 2, angle: cl.rot };
    }
    let b = null;
    for (const cl of clips) b = G.unionBounds(b, F.clipBounds(cl));
    for (const st of sts) b = G.unionBounds(b, F.stitchBounds(st));
    if (!b) return null;
    return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, hw: (b.maxX - b.minX) / 2, hh: (b.maxY - b.minY) / 2, angle: 0 };
  };

  F.frameCorners = function (fr) {
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) =>
      G.add([fr.cx, fr.cy], G.rot([sx * fr.hw, sy * fr.hh], fr.angle))
    );
  };

  // Handle positions in screen space.
  F.frameHandles = function (fr) {
    const corners = F.frameCorners(fr).map(F.toScreen);
    const topMid = F.toScreen(G.add([fr.cx, fr.cy], G.rot([0, -fr.hh], fr.angle)));
    const up = G.rot([0, -1], fr.angle);
    const rot = G.add(topMid, G.mul(up, 26));
    return { corners, topMid, rot };
  };

  // ---- Overlays ------------------------------------------------------------

  function polygon(c, pts) {
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
    c.closePath();
  }

  function linkBadge(c, p) {
    const x = p[0] + 4, y = p[1] + 4;
    c.fillStyle = ACCENT;
    c.beginPath();
    c.roundRect ? c.roundRect(x, y, 22, 14, 7) : c.rect(x, y, 22, 14);
    c.fill();
    c.strokeStyle = '#fff';
    c.lineWidth = 1.6;
    c.beginPath();
    c.ellipse(x + 8.5, y + 7, 4, 3, 0, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.ellipse(x + 13.5, y + 7, 4, 3, 0, 0, Math.PI * 2);
    c.stroke();
  }

  function label(c, text, p, bg) {
    c.font = '600 12px system-ui, -apple-system, sans-serif';
    const w = c.measureText(text).width + 12;
    c.fillStyle = bg || 'rgba(20,20,30,0.85)';
    c.beginPath();
    c.roundRect ? c.roundRect(p[0] - w / 2, p[1] - 11, w, 22, 6) : c.rect(p[0] - w / 2, p[1] - 11, w, 22);
    c.fill();
    c.fillStyle = '#fff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, p[0], p[1] + 0.5);
  }

  function drawOverlays(c, V) {
    const I = F.input || {};
    const op = I.op || null;
    c.save();
    c.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);

    // hover outline
    if (I.hoverId && !S.sel.has(I.hoverId) && !op) {
      const cl = F.clipById(I.hoverId);
      if (cl) {
        polygon(c, F.clipCorners(cl).map(F.toScreen));
        c.strokeStyle = ACCENT;
        c.lineWidth = 1;
        if (S.tool !== 'select') c.setLineDash([5, 4]);
        c.stroke();
        c.setLineDash([]);
      }
      const st = F.stitchById(I.hoverId);
      if (st) strokeStitchPath(c, st, 'rgba(47,111,237,0.6)');
    }

    // selected samples
    for (const cl of F.selectedClips()) {
      polygon(c, F.clipCorners(cl).map(F.toScreen));
      c.strokeStyle = ACCENT;
      c.lineWidth = 1.5;
      c.stroke();
    }
    // selected stitches
    for (const st of F.selectedStitches()) strokeStitchPath(c, st, ACCENT, true);

    // linked badges
    const showLinked = F.selectedClips().some((cl) => cl.linked) || (op && op.linked);
    const hoverClip = I.hoverId && F.clipById(I.hoverId);
    for (const cl of F.linkedClips()) {
      if (showLinked || cl === hoverClip) {
        const b = F.clipBounds(cl);
        linkBadge(c, F.toScreen([b.minX, b.minY]));
      }
    }

    // frame + handles
    const fr = F.selectionFrame();
    if (fr && S.tool === 'select' && !(op && op.type === 'marquee')) {
      const h = F.frameHandles(fr);
      const multi = !(S.sel.size === 1 && F.selectedClips().length === 1);
      if (multi) {
        polygon(c, h.corners);
        c.strokeStyle = ACCENT;
        c.lineWidth = 1;
        c.setLineDash([4, 3]);
        c.stroke();
        c.setLineDash([]);
      }
      c.strokeStyle = ACCENT;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(h.topMid[0], h.topMid[1]);
      c.lineTo(h.rot[0], h.rot[1]);
      c.stroke();
      c.fillStyle = '#fff';
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(h.rot[0], h.rot[1], 5.5, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      for (const p of h.corners) {
        c.fillStyle = '#fff';
        c.fillRect(p[0] - 4.5, p[1] - 4.5, 9, 9);
        c.strokeRect(p[0] - 4.5, p[1] - 4.5, 9, 9);
      }
    }

    // marquee
    if (op && op.type === 'marquee' && op.rect) {
      const a = F.toScreen([op.rect.minX, op.rect.minY]), b = F.toScreen([op.rect.maxX, op.rect.maxY]);
      c.fillStyle = 'rgba(47,111,237,0.08)';
      c.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      c.strokeStyle = ACCENT;
      c.lineWidth = 1;
      c.strokeRect(a[0] + 0.5, a[1] + 0.5, b[0] - a[0], b[1] - a[1]);
    }

    // snap guides
    if (I.guides && I.guides.length) {
      c.strokeStyle = '#E2456B';
      c.lineWidth = 1;
      c.beginPath();
      for (const g of I.guides) {
        const a = F.toScreen(g[0]), b = F.toScreen(g[1]);
        c.moveTo(Math.round(a[0]) + 0.5, Math.round(a[1]) + 0.5);
        c.lineTo(Math.round(b[0]) + 0.5, Math.round(b[1]) + 0.5);
      }
      c.stroke();
    }

    // calibration line of the selected sample (measure tool)
    if (S.tool === 'measure') {
      for (const cl of F.selectedClips()) {
        if (cl.cal && cl.cal.line) {
          const a = F.toScreen(F.toBoard(cl, cl.cal.line[0])), b = F.toScreen(F.toBoard(cl, cl.cal.line[1]));
          measureLine(c, a, b, cl.cal.value + ' ' + cl.cal.unit, 'rgba(47,111,237,0.9)');
        }
      }
    }
    // measure line being drawn / waiting for a length
    if (I.measure) {
      const a = F.toScreen(I.measure.a), b = F.toScreen(I.measure.b);
      measureLine(c, a, b, I.measure.label || '', '#E2456B');
    }

    // size / angle readout while transforming
    if (I.tip) label(c, I.tip.text, [I.tip.sp[0], I.tip.sp[1] + 30]);

    // colour picker loupe
    if (I.loupe) {
      const p = I.loupe.sp;
      const q = [p[0] + 30, p[1] - 30];
      c.beginPath();
      c.arc(q[0], q[1], 20, 0, Math.PI * 2);
      c.fillStyle = I.loupe.hex;
      c.fill();
      c.lineWidth = 3;
      c.strokeStyle = '#fff';
      c.stroke();
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(0,0,0,0.45)';
      c.beginPath();
      c.arc(q[0], q[1], 21.5, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.arc(p[0], p[1], 5, 0, Math.PI * 2);
      c.strokeStyle = '#fff';
      c.lineWidth = 2;
      c.stroke();
      c.strokeStyle = '#000';
      c.lineWidth = 1;
      c.stroke();
    }

    c.restore();
  }

  function strokeStitchPath(c, st, color, ends) {
    const par = F.parentOf(st);
    const pts = st.pts.map((p) => F.toScreen(F.toBoard(par, p)));
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 3;
    c.stroke();
    c.strokeStyle = color;
    c.lineWidth = 1.25;
    c.setLineDash([5, 3]);
    c.stroke();
    c.setLineDash([]);
    if (ends) {
      for (const p of [pts[0], pts[pts.length - 1]]) {
        c.beginPath();
        c.arc(p[0], p[1], 3.5, 0, Math.PI * 2);
        c.fillStyle = '#fff';
        c.fill();
        c.strokeStyle = color;
        c.lineWidth = 1.5;
        c.stroke();
      }
    }
  }

  function measureLine(c, a, b, text, color) {
    c.lineCap = 'round';
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(a[0], a[1]);
    c.lineTo(b[0], b[1]);
    c.stroke();
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.stroke();
    const d = G.sub(b, a);
    const L = Math.hypot(d[0], d[1]) || 1;
    const n = [(-d[1] / L) * 7, (d[0] / L) * 7];
    c.beginPath();
    for (const p of [a, b]) {
      c.moveTo(p[0] - n[0], p[1] - n[1]);
      c.lineTo(p[0] + n[0], p[1] + n[1]);
    }
    c.stroke();
    if (text) label(c, text, [(a[0] + b[0]) / 2 + n[0] * 2.4, (a[1] + b[1]) / 2 + n[1] * 2.4], color);
  }

  // ---- Export --------------------------------------------------------------

  R.exportCanvas = function (onlySelection) {
    const b = F.contentBounds(onlySelection);
    if (!b) return null;
    const m = 24;
    const W = b.maxX - b.minX + 2 * m, H = b.maxY - b.minY + 2 * m;
    let k = 2;
    if (Math.max(W, H) * k > 8000) k = 8000 / Math.max(W, H);
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(W * k);
    cv.height = Math.ceil(H * k);
    const c2 = cv.getContext('2d');
    F.drawScene(c2, { zoom: 1, x: -b.minX + m, y: -b.minY + m, dpr: k, w: W, h: H }, {
      overlays: false,
      only: onlySelection ? S.sel : null,
    });
    return cv;
  };
})(window.Fabrica = window.Fabrica || {});
