// Colour maths and thread matching.
(function (F) {
  'use strict';

  const C = (F.color = {});
  const RAD = Math.PI / 180;

  C.hexToRgb = function (hex) {
    let h = String(hex).replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  C.rgbToHex = function (r, g, b) {
    return '#' + [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  };

  C.normHex = (hex) => C.rgbToHex(...C.hexToRgb(hex));

  function toLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function fromLinear(c) {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return v * 255;
  }

  const XN = 0.95047, ZN = 1.08883;
  const EPS = 216 / 24389, KAPPA = 24389 / 27;

  C.rgbToLab = function (rgb) {
    const R = toLinear(rgb[0]), G = toLinear(rgb[1]), B = toLinear(rgb[2]);
    const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / XN;
    const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
    const Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / ZN;
    const f = (t) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
    const fx = f(X), fy = f(Y), fz = f(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  };

  C.labToRgb = function (lab) {
    const [L, a, b] = lab;
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const inv = (t) => (t * t * t > EPS ? t * t * t : (116 * t - 16) / KAPPA);
    const X = inv(fx) * XN;
    const Y = L > KAPPA * EPS ? fy * fy * fy : L / KAPPA;
    const Z = inv(fz) * ZN;
    const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
    const G = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
    const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
    return [fromLinear(R), fromLinear(G), fromLinear(B)].map((v) => Math.max(0, Math.min(255, v)));
  };

  C.labToLch = ([L, a, b]) => {
    let h = Math.atan2(b, a) / RAD;
    if (h < 0) h += 360;
    return [L, Math.hypot(a, b), h];
  };
  C.lchToLab = ([L, c, h]) => [L, c * Math.cos(h * RAD), c * Math.sin(h * RAD)];

  C.hexToLab = (hex) => C.rgbToLab(C.hexToRgb(hex));
  C.labToHex = (lab) => C.rgbToHex(...C.labToRgb(lab));

  // CIEDE2000 colour difference.
  C.deltaE = function (l1, l2) {
    const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
    const Cb7 = Math.pow((C1 + C2) / 2, 7);
    const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 6103515625)));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const hue = (b, a) => {
      if (a === 0 && b === 0) return 0;
      const h = Math.atan2(b, a) / RAD;
      return h < 0 ? h + 360 : h;
    };
    const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
    const dLp = L2 - L1, dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) {
      dhp = h2p - h1p;
      if (dhp > 180) dhp -= 360;
      else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * RAD) / 2);
    const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hbp = h1p + h2p;
    if (C1p * C2p !== 0) {
      if (Math.abs(h1p - h2p) > 180) hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
      else hbp = (h1p + h2p) / 2;
    }
    const T = 1 - 0.17 * Math.cos((hbp - 30) * RAD) + 0.24 * Math.cos(2 * hbp * RAD) +
      0.32 * Math.cos((3 * hbp + 6) * RAD) - 0.2 * Math.cos((4 * hbp - 63) * RAD);
    const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
    const Cbp7 = Math.pow(Cbp, 7);
    const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + 6103515625));
    const Lm = (Lbp - 50) * (Lbp - 50);
    const Sl = 1 + (0.015 * Lm) / Math.sqrt(20 + Lm);
    const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
    const Rt = -Math.sin(2 * dTheta * RAD) * Rc;
    const tl = dLp / Sl, tc = dCp / Sc, th = dHp / Sh;
    return Math.sqrt(tl * tl + tc * tc + th * th + Rt * tc * th);
  };

  // Mix two hex colours, t = 0 → a, t = 1 → b.
  C.mix = function (a, b, t) {
    const A = C.hexToRgb(a), B = C.hexToRgb(b);
    return C.rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  };

  C.luminance = function (hex) {
    const [r, g, b] = C.hexToRgb(hex);
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  };

  C.isDark = (hex) => C.luminance(hex) < 0.22;

  // ---- Thread libraries ----------------------------------------------------

  let threads = null;

  // All threads from every registered library, with precomputed Lab/LCh.
  C.threads = function () {
    if (threads) return threads;
    threads = [];
    const libs = F.threadLibraries || {};
    for (const key of Object.keys(libs)) {
      libs[key].colors.forEach(([code, name, hex], i) => {
        const lab = C.hexToLab(hex);
        threads.push({ lib: key, code, name, hex: C.normHex(hex), lab, lch: C.labToLch(lab), order: i });
      });
    }
    return threads;
  };

  C.threadKey = (t) => (t ? t.lib + ':' + t.code : '');

  C.findThread = function (lib, code) {
    return C.threads().find((t) => t.lib === lib && t.code === code) || null;
  };

  // Nearest n threads to a Lab colour, skipping keys in `exclude`.
  C.nearest = function (lab, n, exclude) {
    const out = [];
    for (const t of C.threads()) {
      if (exclude && exclude.has(C.threadKey(t))) continue;
      out.push({ t, d: C.deltaE(lab, t.lab) });
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, n);
  };

  // Thread ideas for a fabric colour. Returns rows of {label, hint, items}.
  C.suggest = function (hex) {
    const lab = C.hexToLab(hex);
    const [L, c, h] = C.labToLch(lab);
    const used = new Set();
    const take = (targetLab, n) => {
      const res = C.nearest(targetLab, n, used);
      res.forEach((r) => used.add(C.threadKey(r.t)));
      return res;
    };

    const closest = take(lab, 6);

    const shades = [];
    for (const dL of [-24, -12, 12, 24]) {
      const tL = Math.max(2, Math.min(98, L + dL));
      const r = take([tL, lab[1], lab[2]], 1);
      if (r.length) shades.push(r[0]);
    }

    const contrast = [];
    if (c < 10) {
      // Nearly neutral: contrast by lightness, plus a few accent colours.
      const r = take([L > 55 ? 20 : 88, lab[1], lab[2]], 2);
      contrast.push(...r);
      for (const hue of [30, 150, 260]) contrast.push(...take(C.lchToLab([60, 45, hue]), 1));
    } else {
      contrast.push(...take(C.lchToLab([L, c, (h + 180) % 360]), 2));
      contrast.push(...take(C.lchToLab([L, c, (h + 150) % 360]), 1));
      contrast.push(...take(C.lchToLab([L, c, (h + 210) % 360]), 1));
      contrast.push(...take(C.lchToLab([L > 55 ? 22 : 85, c * 0.6, h]), 1));
    }

    const neighbours = [];
    if (c >= 10) {
      for (const dh of [-35, 35, -60, 60]) {
        neighbours.push(...take(C.lchToLab([L, Math.max(c, 20), (h + dh + 360) % 360]), 1));
      }
    }

    const rows = [
      { label: 'Blends in', hint: 'Closest thread colours', items: closest },
      { label: 'Lighter / darker', hint: 'Same colour, tone on tone', items: shades },
      { label: 'Contrast', hint: 'Stands out (complementary colours)', items: contrast },
    ];
    if (neighbours.length) rows.push({ label: 'Neighbours', hint: 'Harmonious nearby hues', items: neighbours });
    return rows;
  };

  // Sort helpers for the palette.
  C.sorters = {
    card: (a, b) => a.order - b.order,
    number: (a, b) => {
      const na = parseInt(a.code, 10), nb = parseInt(b.code, 10);
      const ia = isNaN(na), ib = isNaN(nb);
      if (ia !== ib) return ia ? -1 : 1;
      if (ia) return a.code.localeCompare(b.code);
      return na - nb || a.code.localeCompare(b.code);
    },
    hue: (a, b) => {
      // Greys first (by lightness), then by hue bands and lightness.
      const ga = a.lch[1] < 8, gb = b.lch[1] < 8;
      if (ga !== gb) return ga ? -1 : 1;
      if (ga) return b.lch[0] - a.lch[0];
      const ha = Math.floor(((a.lch[2] + 15) % 360) / 20), hb = Math.floor(((b.lch[2] + 15) % 360) / 20);
      return ha - hb || b.lch[0] - a.lch[0];
    },
    light: (a, b) => b.lch[0] - a.lch[0],
  };
})(window.Fabrica = window.Fabrica || {});
