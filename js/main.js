// Boot: wire everything up and restore the last board.
(function (F) {
  'use strict';

  const S = F.state;

  function applyPrefs(p) {
    if (!p) return;
    const o = S.opts;
    if (p.kinds) for (const k of Object.keys(o.kinds)) if (p.kinds[k]) Object.assign(o.kinds[k], p.kinds[k]);
    if (F.stitchRender.KINDS.some((k) => k.id === p.kind)) o.kind = p.kind;
    if (p.width > 0) o.width = p.width;
    if (typeof p.color === 'string') o.color = p.color;
    if ('thread' in p) o.thread = p.thread;
    if (typeof p.attach === 'boolean') o.attach = p.attach;
    if (p.sort) o.sort = p.sort;
  }

  async function boot() {
    const canvas = document.getElementById('board');
    F.render.init(canvas);
    const vs = F.viewSize();
    S.view.x = vs.w / 2;
    S.view.y = vs.h / 2;
    F.input.init(canvas);

    let restored = false;
    try {
      const saved = await F.store.load();
      applyPrefs(saved.prefs);
      if (saved.doc) {
        for (const [id, blob] of saved.images) {
          try {
            S.images.set(id, await F.loadImageRecord(blob));
            F.store.markImageSaved(id);
          } catch (e) {
            console.warn('Could not load saved image', id, e);
          }
        }
        S.doc = Object.assign(F.newDoc(), saved.doc);
        restored = true;
      }
    } catch (e) {
      console.warn('Could not restore the saved board', e);
    }

    F.ui.init();
    if (restored) F.fitView(false);
    F.requestRender();
    F.ui.refresh();
    F.setTool('select');

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) F.saveNow();
    });
    window.addEventListener('pagehide', () => F.saveNow());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.Fabrica = window.Fabrica || {});
