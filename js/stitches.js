// Procedural stitch rendering. Everything here works in the stitch's local
// units (image pixels of the parent sample, or board units for free stitches).
(function (F) {
  'use strict';

  const G = F.geom;
  const SR = (F.stitchRender = {});

  SR.KINDS = [
    { id: 'running', label: 'Running', space: 'Gap' },
    { id: 'back', label: 'Back', space: null },
    { id: 'zigzag', label: 'Zigzag', space: 'Zigzag width' },
    { id: 'cross', label: 'Cross', space: null, len: 'Cross size' },
    { id: 'blanket', label: 'Blanket', space: 'Stitch height' },
  ];
  SR.kindInfo = (id) => SR.KINDS.find((k) => k.id === id) || SR.KINDS[0];

  // ---- Geometry ------------------------------------------------------------

  // Returns layers (drawn bottom to top); each layer is a list of runs and
  // each run is a polyline of one visible piece of thread.
  function computeLayers(st) {
    const S = G.sampler(st.pts);
    const L = S.total;
    const len = Math.max(st.len, 1e-3);
    const w = Math.max(st.w, 1e-3);
    if (L < 1e-6) return [[[st.pts[0], [st.pts[0][0] + 1e-3, st.pts[0][1]]]]];

    switch (st.kind) {
      case 'back': {
        const n = Math.max(1, Math.round(L / len));
        const step = L / n;
        const gap = Math.min(w * 0.55, step * 0.3);
        const runs = [];
        for (let i = 0; i < n; i++) runs.push(S.slice(i * step + gap / 2, (i + 1) * step - gap / 2));
        return [runs];
      }
      case 'zigzag': {
        const A = Math.max(st.space, 0) / 2;
        const n = Math.max(1, Math.round(L / (len / 2)));
        const step = L / n;
        const pts = [];
        for (let i = 0; i <= n; i++) {
          const { p, t } = S.at(i * step);
          const sgn = i % 2 ? -1 : 1;
          pts.push([p[0] - t[1] * A * sgn, p[1] + t[0] * A * sgn]);
        }
        const runs = [];
        for (let i = 1; i < pts.length; i++) runs.push([pts[i - 1], pts[i]]);
        return [runs];
      }
      case 'cross': {
        const cell = len;
        const n = Math.max(1, Math.floor(L / cell + 1e-6));
        const off = (L - n * cell) / 2;
        const h = cell * 0.46;
        const under = [], over = [];
        for (let i = 0; i < n; i++) {
          const { p, t } = S.at(off + (i + 0.5) * cell);
          const nx = -t[1], ny = t[0];
          under.push([
            [p[0] - t[0] * h + nx * h, p[1] - t[1] * h + ny * h],
            [p[0] + t[0] * h - nx * h, p[1] + t[1] * h - ny * h],
          ]);
          over.push([
            [p[0] - t[0] * h - nx * h, p[1] - t[1] * h - ny * h],
            [p[0] + t[0] * h + nx * h, p[1] + t[1] * h + ny * h],
          ]);
        }
        return [under, over];
      }
      case 'blanket': {
        const H = Math.max(st.space, 0);
        const n = Math.max(1, Math.round(L / len));
        const step = L / n;
        const legs = [], base = [];
        for (let i = 0; i <= n; i++) {
          const { p, t } = S.at(i * step);
          legs.push([p, [p[0] - t[1] * H, p[1] + t[0] * H]]);
        }
        for (let i = 0; i < n; i++) base.push(S.slice(i * step, (i + 1) * step));
        return [legs, base];
      }
      default: {
        // running stitch, centred along the path
        const gap = Math.max(st.space, 0);
        const period = len + gap;
        const n = Math.floor((L + gap) / period + 1e-6);
        if (n < 1) return [[S.slice(0, L)]];
        const off = (L - (n * period - gap)) / 2;
        const runs = [];
        for (let i = 0; i < n; i++) runs.push(S.slice(off + i * period, off + i * period + len));
        return [runs];
      }
    }
  }

  // Shortened copies of runs (for the highlight) and twist marks.
  function computeDetail(layers, w) {
    const hl = [], tw = [];
    for (const runs of layers) {
      const h = [], t = [];
      for (const r of runs) {
        const S = G.sampler(r);
        const L = S.total;
        const d = w * 0.35;
        if (L > d * 2.2) h.push(S.slice(d, L - d));
        for (let s = w * 0.55; s < L - w * 0.45; s += w * 0.75) {
          const { p, t: tg } = S.at(s);
          const nx = -tg[1], ny = tg[0];
          t.push([
            [p[0] - tg[0] * w * 0.28 - nx * w * 0.4, p[1] - tg[1] * w * 0.28 - ny * w * 0.4],
            [p[0] + tg[0] * w * 0.28 + nx * w * 0.4, p[1] + tg[1] * w * 0.28 + ny * w * 0.4],
          ]);
        }
      }
      hl.push(h);
      tw.push(t);
    }
    return { hl, tw };
  }

  const cache = new WeakMap();
  function geometry(st) {
    const key = st.kind + '|' + st.len + '|' + st.space + '|' + st.w;
    let c = cache.get(st);
    if (!c || c.key !== key || c.pts !== st.pts) {
      const layers = computeLayers(st);
      c = { key, pts: st.pts, layers, detail: null };
      cache.set(st, c);
    }
    return c;
  }

  SR.layers = (st) => geometry(st).layers;

  // ---- Drawing -------------------------------------------------------------

  const tones = new Map();
  function toneFor(color) {
    let t = tones.get(color);
    if (!t) {
      t = { light: F.color.mix(color, '#FFFFFF', 0.6), dark: F.color.mix(color, '#000000', 0.5) };
      tones.set(color, t);
    }
    return t;
  }

  function trace(ctx, runs, dx, dy) {
    ctx.beginPath();
    for (const r of runs) {
      ctx.moveTo(r[0][0] + dx, r[0][1] + dy);
      for (let i = 1; i < r.length; i++) ctx.lineTo(r[i][0] + dx, r[i][1] + dy);
    }
  }

  // o: { pxPerUnit, shadowDir: [x, y] (local, unit), alpha }
  SR.draw = function (ctx, st, o) {
    const g = geometry(st);
    const minW = 1 / o.pxPerUnit;
    const W = Math.max(st.w, minW);
    const sw = W * o.pxPerUnit;
    const exact = W === st.w;
    if (exact && sw >= 2.2 && !g.detail) g.detail = computeDetail(g.layers, st.w);
    const tone = toneFor(st.color);
    const [sx, sy] = o.shadowDir;
    const alpha = o.alpha == null ? 1 : o.alpha;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    g.layers.forEach((runs, li) => {
      if (sw >= 1.6) {
        ctx.globalAlpha = 0.34 * alpha;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = W * 1.12;
        trace(ctx, runs, sx * W * 0.3, sy * W * 0.3);
        ctx.stroke();
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = W;
      trace(ctx, runs, 0, 0);
      ctx.stroke();
      if (exact && g.detail && sw >= 2.2) {
        if (sw >= 5) {
          ctx.globalAlpha = 0.28 * alpha;
          ctx.strokeStyle = tone.dark;
          ctx.lineWidth = W * 0.14;
          trace(ctx, g.detail.tw[li], 0, 0);
          ctx.stroke();
        }
        ctx.globalAlpha = 0.5 * alpha;
        ctx.strokeStyle = tone.light;
        ctx.lineWidth = W * 0.3;
        trace(ctx, g.detail.hl[li], -sx * W * 0.17, -sy * W * 0.17);
        ctx.stroke();
      }
    });
    ctx.restore();
  };

  // Small preview of a stitch kind, for buttons. Draws into a canvas element.
  SR.preview = function (canvas, kind, color) {
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth || 44, ch = canvas.clientHeight || 18;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const y = kind === 'blanket' ? ch * 0.3 : ch / 2;
    const st = {
      kind, color, pts: [[5, y], [cw - 5, y]], w: 2,
      len: { running: 7, back: 7, zigzag: 6, cross: 8, blanket: 7 }[kind] || 7,
      space: { running: 4, zigzag: 8, blanket: 7 }[kind] || 0,
    };
    SR.draw(ctx, st, { pxPerUnit: dpr, shadowDir: [0.29, 0.96] });
  };
})(window.Fabrica = window.Fabrica || {});
