// Vector and polyline helpers. Points are [x, y] arrays.
(function (F) {
  'use strict';

  const G = (F.geom = {});

  G.dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  G.sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  G.add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  G.mul = (a, k) => [a[0] * k, a[1] * k];
  G.dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  G.rot = (p, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    return [c * p[0] - s * p[1], s * p[0] + c * p[1]];
  };
  // Rotate p around centre o by ang, and scale by k.
  G.rotScaleAbout = (p, o, ang, k) => G.add(o, G.mul(G.rot(G.sub(p, o), ang), k));

  G.length = function (pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += G.dist(pts[i - 1], pts[i]);
    return L;
  };

  G.bounds = function (pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    return { minX, minY, maxX, maxY };
  };

  G.unionBounds = function (a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
      maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
    };
  };

  G.boundsIntersect = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

  G.distToSegment = function (p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };

  G.distToPolyline = function (p, pts) {
    if (pts.length === 1) return G.dist(p, pts[0]);
    let d = Infinity;
    for (let i = 1; i < pts.length; i++) d = Math.min(d, G.distToSegment(p, pts[i - 1], pts[i]));
    return d;
  };

  // Ramer–Douglas–Peucker simplification.
  G.simplify = function (pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop();
      let maxD = 0, idx = -1;
      for (let i = i0 + 1; i < i1; i++) {
        const d = G.distToSegment(pts[i], pts[i0], pts[i1]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (idx >= 0 && maxD > eps) {
        keep[idx] = 1;
        stack.push([i0, idx], [idx, i1]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  };

  // Chaikin corner cutting; keeps the end points.
  G.smooth = function (pts, iterations) {
    let out = pts;
    for (let k = 0; k < iterations && out.length > 2; k++) {
      const next = [out[0]];
      for (let i = 0; i < out.length - 1; i++) {
        const a = out[i], b = out[i + 1];
        next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      }
      next.push(out[out.length - 1]);
      out = next;
    }
    return out;
  };

  // Arc-length sampler for a polyline.
  G.sampler = function (pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + G.dist(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1];

    function seg(s) {
      // index i such that cum[i] <= s <= cum[i+1]
      let lo = 0, hi = pts.length - 2;
      if (hi < 0) return 0;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cum[mid] <= s) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    }

    function at(s) {
      if (pts.length === 1) return { p: pts[0], t: [1, 0] };
      s = Math.max(0, Math.min(total, s));
      const i = seg(s);
      const a = pts[i], b = pts[i + 1];
      const L = cum[i + 1] - cum[i] || 1e-9;
      const u = (s - cum[i]) / L;
      return {
        p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u],
        t: [(b[0] - a[0]) / L, (b[1] - a[1]) / L],
      };
    }

    function slice(s0, s1) {
      s0 = Math.max(0, s0);
      s1 = Math.min(total, s1);
      const out = [at(s0).p];
      if (s1 <= s0) return out;
      const i0 = seg(s0), i1 = seg(s1);
      for (let i = i0 + 1; i <= i1; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]);
      out.push(at(s1).p);
      return out;
    }

    return { total, at, slice };
  };

  G.pointInPolygon = function (p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
})(window.Fabrica = window.Fabrica || {});
