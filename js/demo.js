// Procedurally drawn demo fabrics, so the app can be tried without screenshots.
// Each swatch is 12 × 10 cm, drawn at a different pixel density (as if the
// screenshots came from different shops), and comes pre-measured.
(function (F) {
  'use strict';

  const S = F.state;

  function rand(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  // Woven-looking texture: per-pixel noise plus faint warp/weft lines.
  function weave(ctx, w, h, px, seed) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const r = rand(seed);
    const pitch = Math.max(2, Math.round(px / 12));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let k = (r() - 0.5) * 16;
        if (x % pitch === 0) k -= 7;
        if (y % pitch === 0) k -= 5;
        d[i] += k;
        d[i + 1] += k;
        d[i + 2] += k;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function gingham(ctx, w, h, px) {
    ctx.fillStyle = '#FBF8F2';
    ctx.fillRect(0, 0, w, h);
    const c = px * 0.6; // 6 mm checks
    ctx.fillStyle = 'rgba(196, 44, 56, 0.55)';
    for (let x = 0; x < w; x += 2 * c) ctx.fillRect(x, 0, c, h);
    for (let y = 0; y < h; y += 2 * c) ctx.fillRect(0, y, w, c);
  }

  function stripes(ctx, w, h, px) {
    ctx.fillStyle = '#F1E9D8';
    ctx.fillRect(0, 0, w, h);
    const rep = px * 2.4;
    for (let x = -rep; x < w + rep; x += rep) {
      ctx.fillStyle = '#1F2D4F';
      ctx.fillRect(x, 0, px * 1.2, h);
      ctx.fillStyle = '#D9A33A';
      ctx.fillRect(x + px * 1.65, 0, px * 0.18, h);
    }
  }

  function dots(ctx, w, h, px) {
    ctx.fillStyle = '#D9A83F';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#FFF9EC';
    const g = px * 1.5, r = px * 0.22;
    for (let row = 0, y = g / 2; y < h + g; y += g / 2, row++) {
      for (let x = row % 2 ? g / 2 : 0; x < w + g; x += g) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function floral(ctx, w, h, px) {
    ctx.fillStyle = '#8FA48A';
    ctx.fillRect(0, 0, w, h);
    const rep = px * 3;
    const r = rand(7);
    for (let y = -rep; y < h + rep; y += rep / 2) {
      for (let x = -rep; x < w + rep; x += rep / 2) {
        const cx = x + (r() - 0.5) * rep * 0.3, cy = y + (r() - 0.5) * rep * 0.3;
        const s = px * (0.35 + r() * 0.2);
        ctx.fillStyle = r() > 0.5 ? '#F4E6DA' : '#E8B7A6';
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2 + r();
          ctx.beginPath();
          ctx.ellipse(cx + Math.cos(a) * s * 0.55, cy + Math.sin(a) * s * 0.55, s * 0.42, s * 0.28, a, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#D69B3B';
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#5F7559';
        ctx.lineWidth = px * 0.06;
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.8, cy + s * 0.4);
        ctx.quadraticCurveTo(cx + s * 1.3, cy + s * 0.2, cx + s * 1.6, cy + s * 0.9);
        ctx.stroke();
      }
    }
  }

  const SWATCHES = [
    { name: 'Gingham (demo)', draw: gingham, px: 30 },
    { name: 'Navy stripe (demo)', draw: stripes, px: 44 },
    { name: 'Mustard dot (demo)', draw: dots, px: 24 },
    { name: 'Sage floral (demo)', draw: floral, px: 36 },
  ];

  function render(sw, i) {
    const w = Math.round(12 * sw.px), h = Math.round(10 * sw.px);
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    sw.draw(ctx, w, h, sw.px);
    weave(ctx, w, h, sw.px, 11 + i);
    return new Promise((res) => cv.toBlob((b) => {
      b.name = sw.name;
      res(b);
    }, 'image/png'));
  }

  F.addDemo = async function () {
    const blobs = await Promise.all(SWATCHES.map(render));
    const clips = await F.addImages(blobs);
    if (!clips.length) return;
    // These were "measured" at 12 cm wide: show them at real size, linked.
    const hasLinked = S.doc.clips.some((c) => c.linked && !clips.includes(c));
    if (!hasLinked) S.doc.pxPerCm = 18;
    const gap = 16 / S.view.zoom;
    let total = -gap;
    clips.forEach((c, i) => {
      const sw = SWATCHES[i];
      c.name = sw.name;
      c.cal = { pxPerCm: sw.px, source: 'width', value: '12', unit: 'cm' };
      c.linked = true;
      c.scale = S.doc.pxPerCm / sw.px;
      total += c.w * c.scale + gap;
    });
    const vs = F.viewSize();
    const centre = F.screenToBoard([vs.w / 2, vs.h / 2]);
    let x = centre[0] - total / 2;
    for (const c of clips) {
      c.x = x + (c.w * c.scale) / 2;
      c.y = centre[1];
      x += c.w * c.scale + gap;
    }
    F.changed();
    F.fitView(true);
    F.toast('Demo swatches are measured, so they are shown at real size and linked. Try resizing one!', 5000);
  };
})(window.Fabrica = window.Fabrica || {});
