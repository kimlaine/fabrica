// Side panels, toolbar, palette, inspector, toasts, dialogs.
(function (F) {
  'use strict';

  const S = F.state;
  const C = F.color;
  const G = F.geom;
  const U = (F.ui = {});
  const $ = (id) => document.getElementById(id);
  const RAD = Math.PI / 180;

  const BG_PRESETS = [
    ['#FFFFFF', 'White'],
    ['#F3EFE6', 'Linen'],
    ['#D9D5CD', 'Light grey'],
    ['#8C8782', 'Grey'],
    ['#3A3836', 'Charcoal'],
    ['#141414', 'Black'],
  ];

  const HINTS = {
    select: 'Click a sample to select it · drag to move · ⇧-click or drag a box to select several · double-click a stitch to edit it',
    stitch: 'Drag on a sample to stitch · hold ⇧ for a straight line · ⌥-click to pick a colour · click a stitch to select it',
    pick: 'Click a fabric to get matching thread colours',
    measure: 'Drag across something of known size on a sample — a ruler, or one pattern repeat — then type its length',
    pan: 'Drag to move around · pinch or ⌘-scroll to zoom',
  };

  // px-per-cm slider: logarithmic, 2 … 400 px
  const PX_MIN = 2, PX_MAX = 400;
  const pxFromSlider = (v) => PX_MIN * Math.pow(PX_MAX / PX_MIN, v / 1000);
  const sliderFromPx = (px) => (1000 * Math.log(Math.max(PX_MIN, Math.min(PX_MAX, px)) / PX_MIN)) / Math.log(PX_MAX / PX_MIN);

  const fmt = (v, d) => {
    const s = (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
    return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  };

  // Set an input's value unless the user is typing in it.
  function setVal(el, v) {
    if (document.activeElement === el && el.type !== 'range') return;
    if (el.value !== String(v)) el.value = v;
  }

  function show(el, on) {
    el.hidden = !on;
  }

  // ---- Toast ---------------------------------------------------------------

  let toastTimer = null;
  F.toast = function (msg, ms) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('on');
      setTimeout(() => {
        if (!el.classList.contains('on')) el.hidden = true;
      }, 250);
    }, ms || 3200);
  };

  // ---- Init ----------------------------------------------------------------

  U.init = function () {
    // toolbar
    document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => F.setTool(b.dataset.tool)));
    $('undo').addEventListener('click', () => F.undo());
    $('redo').addEventListener('click', () => F.redo());
    $('add-images').addEventListener('click', () => $('file-images').click());
    $('empty-add').addEventListener('click', () => $('file-images').click());
    $('demo').addEventListener('click', () => F.addDemo());
    $('file-images').addEventListener('change', (e) => {
      const files = [...e.target.files].filter((f) => f.type.startsWith('image/'));
      if (files.length) F.addImages(files);
      e.target.value = '';
    });
    $('save').addEventListener('click', () => U.saveFile());
    $('open').addEventListener('click', () => U.openFile());
    $('file-open').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) loadProjectFile(f);
    });
    $('export').addEventListener('click', (e) => {
      e.stopPropagation();
      $('export-menu').hidden = !$('export-menu').hidden;
    });
    $('export-menu').addEventListener('click', (e) => {
      const b = e.target.closest('[data-export]');
      if (!b) return;
      $('export-menu').hidden = true;
      if (b.dataset.export === 'copy') U.copyPng();
      else U.exportPng();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-wrap')) $('export-menu').hidden = true;
    });
    $('help-btn').addEventListener('click', () => U.showHelp());

    // zoom
    $('zoom-in').addEventListener('click', () => F.zoomBy(1.25));
    $('zoom-out').addEventListener('click', () => F.zoomBy(0.8));
    $('zoom-reset').addEventListener('click', () => F.zoomTo(1));
    $('zoom-fit').addEventListener('click', () => F.fitView(false));

    initSelectionPanel();
    initStitchPanel();
    initThreadPanel();
    initBoardPanel();
    initMeasure();
    ready = true;
    U.refresh();
  };

  let refreshPending = false;
  let ready = false;
  U.refresh = function () {
    if (refreshPending || !ready) return;
    refreshPending = true;
    requestAnimationFrame(() => {
      refreshPending = false;
      doRefresh();
    });
  };

  function doRefresh() {
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === S.tool));
    $('undo').disabled = !F.history.undo.length;
    $('redo').disabled = !F.history.redo.length;
    const empty = !S.doc.clips.length && !S.doc.stitches.length;
    show($('empty'), empty);
    $('tool-hint').textContent = HINTS[S.tool] || '';
    show($('tool-hint'), !empty);
    $('stage').dataset.tool = S.tool;
    refreshSelection();
    refreshStitch();
    refreshThread();
    refreshBoard();
    U.refreshZoom();
  }

  U.refreshZoom = function () {
    if (!ready) return;
    $('zoom-reset').textContent = Math.round(S.view.zoom * 100) + '%';
  };

  // ---- Selection panel -----------------------------------------------------

  function oneClip() {
    const clips = F.selectedClips();
    return clips.length === 1 && F.selectedStitches().length === 0 ? clips[0] : null;
  }

  // Scale a sample by k around its centre; linked samples come along.
  function scaleClip(clip, k) {
    if (!(k > 0) || Math.abs(k - 1) < 1e-9) return;
    F.checkpoint();
    const group = clip.linked ? F.linkedClips() : [clip];
    if (!group.includes(clip)) group.push(clip);
    F.scaleClipsAbout(group, [clip.x, clip.y], k);
    if (clip.linked) S.doc.pxPerCm *= k;
    F.changed();
  }

  function calibrateFromSize(clip, cm, dim) {
    if (!(cm > 0)) return;
    const px = (dim === 'h' ? clip.h : clip.w) / cm;
    const n = F.calibrate(clip, px, { source: dim === 'h' ? 'height' : 'width', value: fmt(cm, 2), unit: 'cm' });
    F.toast(n ? `Real size set — now in proportion with ${n} linked sample${n > 1 ? 's' : ''}.` : 'Real size set. Measure other samples too and they will match this one.');
  }

  function initSelectionPanel() {
    $('sel-dup').addEventListener('click', () => F.duplicateSelection());
    $('sel-del').addEventListener('click', () => F.deleteSelection());

    const name = $('clip-name');
    name.addEventListener('input', () => {
      const c = oneClip();
      if (!c) return;
      F.beginEdit('name:' + c.id);
      c.name = name.value;
      F.changed();
    });
    name.addEventListener('change', () => F.endEdit());
    name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());

    $('clip-size').addEventListener('change', (e) => {
      const c = oneClip();
      const v = parseFloat(e.target.value);
      if (c && v > 0) scaleClip(c, v / 100 / c.scale);
    });
    $('clip-rot').addEventListener('change', (e) => {
      const c = oneClip();
      const v = parseFloat(e.target.value);
      if (!c || isNaN(v)) return;
      F.checkpoint();
      c.rot = F.normAngle(v * RAD);
      F.changed();
    });
    $('rot-ccw').addEventListener('click', () => F.rotateSelection(-90));
    $('rot-cw').addEventListener('click', () => F.rotateSelection(90));
    $('flip').addEventListener('click', () => F.flipSelection());

    $('clip-realw').addEventListener('change', (e) => {
      const c = oneClip();
      if (c) calibrateFromSize(c, parseFloat(e.target.value), 'w');
    });
    $('clip-realh').addEventListener('change', (e) => {
      const c = oneClip();
      if (c) calibrateFromSize(c, parseFloat(e.target.value), 'h');
    });
    $('clip-measure').addEventListener('click', () => {
      F.setTool('measure');
      F.toast('Drag across something of known size on the picture.');
    });
    $('clip-uncal').addEventListener('click', () => {
      const c = oneClip();
      if (c) F.removeCalibration(c);
    });
    $('clip-linked').addEventListener('change', (e) => {
      const c = oneClip();
      if (!c) return;
      F.setLinked([c], e.target.checked);
      if (e.target.checked && c.cal) F.toast('Shown at real size and linked.');
    });
    $('clip-edit-stitches').addEventListener('click', () => {
      const c = oneClip();
      if (!c) return;
      const ids = F.stitchesOf(c.id).map((s) => s.id);
      if (ids.length) F.select(ids);
    });
    $('to-front').addEventListener('click', () => F.reorder('front'));
    $('to-back').addEventListener('click', () => F.reorder('back'));

    $('arrange-row').addEventListener('click', () => F.arrange('row', $('arrange-gap').checked));
    $('arrange-grid').addEventListener('click', () => F.arrange('grid', $('arrange-gap').checked));
    $('multi-link').addEventListener('click', () => {
      F.setLinked(F.selectedClips(), true);
      F.toast('Linked — resizing one of them now resizes all linked samples.');
    });
    $('multi-unlink').addEventListener('click', () => F.setLinked(F.selectedClips(), false));
  }

  function refreshSelection() {
    const clips = F.selectedClips();
    const sts = F.selectedStitches();
    const panel = $('sel-panel');
    if (!clips.length && !sts.length) {
      show(panel, false);
      return;
    }
    show(panel, true);
    const single = clips.length === 1 && !sts.length ? clips[0] : null;
    show($('sel-clip'), !!single);
    show($('sel-multi'), clips.length > 1 || (clips.length > 0 && sts.length > 0));
    show($('sel-stitches'), !clips.length);
    const nStitch = (n) => n + (n === 1 ? ' stitch' : ' stitches');
    const nSample = (n) => n + (n === 1 ? ' sample' : ' samples');

    if (single) {
      const c = single;
      $('sel-title').textContent = 'Sample';
      setVal($('clip-name'), c.name || '');
      setVal($('clip-size'), Math.round(c.scale * 1000) / 10);
      setVal($('clip-rot'), Math.round((c.rot / RAD) * 10) / 10);
      if (c.cal) {
        setVal($('clip-realw'), fmt(c.w / c.cal.pxPerCm, 1));
        setVal($('clip-realh'), fmt(c.h / c.cal.pxPerCm, 1));
      } else {
        setVal($('clip-realw'), '');
        setVal($('clip-realh'), '');
      }
      show($('clip-uncal'), !!c.cal);
      let info;
      if (c.cal) {
        const how = c.cal.line ? `Measured: the line is ${c.cal.value} ${c.cal.unit}. ` : '';
        info = how + (c.linked ? 'Shown at real size.' : 'Not linked, so not shown at real size.');
      } else {
        info = 'Not measured yet. Type the real width, or measure something of known size on the picture.';
      }
      $('cal-info').textContent = info;
      $('clip-linked').checked = !!c.linked;
      const n = F.stitchesOf(c.id).length;
      $('clip-stitch-count').textContent = n ? nStitch(n) + ' on this sample' : 'No stitches yet';
      $('clip-edit-stitches').disabled = !n;
    } else if (clips.length) {
      $('sel-title').textContent = nSample(clips.length) + (sts.length ? ' + ' + nStitch(sts.length) : '');
      const linked = clips.filter((c) => c.linked).length;
      $('sel-summary').textContent = linked
        ? `${linked} of them ${linked === 1 ? 'is' : 'are'} linked. Resizing a linked sample resizes every linked sample.`
        : 'None of these are linked yet.';
      $('arrange-row').disabled = $('arrange-grid').disabled = clips.length < 2;
    } else {
      $('sel-title').textContent = nStitch(sts.length);
    }
  }

  // ---- Stitch panel --------------------------------------------------------

  const kindCanvases = {};

  function initStitchPanel() {
    const wrap = $('kind-buttons');
    for (const k of F.stitchRender.KINDS) {
      const b = document.createElement('button');
      b.className = 'kind';
      b.dataset.kind = k.id;
      b.setAttribute('role', 'radio');
      b.title = k.label + ' stitch';
      const cv = document.createElement('canvas');
      kindCanvases[k.id] = cv;
      const label = document.createElement('span');
      label.textContent = k.label;
      b.append(cv, label);
      b.addEventListener('click', () => setKind(k.id));
      wrap.appendChild(b);
    }

    bindSlider('st-len', 'st-len-n', 'len');
    bindSlider('st-space', 'st-space-n', 'space');
    bindSlider('st-w', 'st-w-n', 'w');

    $('st-preset').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      e.target.value = '';
      if (v > 0) {
        if (targetStitches().length) F.checkpoint();
        setStitchProp('w', v);
        F.changed();
      }
    });
    $('st-attach').addEventListener('change', (e) => {
      S.opts.attach = e.target.checked;
      savePrefs();
    });
  }

  function targetStitches() {
    return F.selectedStitches();
  }

  function setKind(kind) {
    S.opts.kind = kind;
    const sts = targetStitches();
    if (sts.length) {
      F.checkpoint();
      const d = F.kindDefaults(kind);
      for (const st of sts) {
        const u = F.unitsPerMm(F.parentOf(st));
        st.kind = kind;
        st.len = d.len * u;
        st.space = d.space * u;
      }
      F.changed();
    } else {
      U.refresh();
      F.requestRender();
    }
    savePrefs();
  }

  // prop: 'len' | 'space' | 'w'; v in mm
  function setStitchProp(prop, v) {
    const kd = F.kindDefaults(S.opts.kind);
    if (prop === 'w') S.opts.width = v;
    else kd[prop] = v;
    for (const st of targetStitches()) {
      st[prop] = v * F.unitsPerMm(F.parentOf(st));
      if (prop !== 'w') F.kindDefaults(st.kind)[prop] = v;
    }
    savePrefs();
  }

  function bindSlider(rangeId, numId, prop) {
    const r = $(rangeId), n = $(numId);
    r.addEventListener('input', () => {
      if (targetStitches().length) F.beginEdit('st-' + prop);
      setStitchProp(prop, parseFloat(r.value));
      n.value = r.value;
      F.changed();
    });
    r.addEventListener('change', () => F.endEdit());
    n.addEventListener('change', () => {
      const v = parseFloat(n.value);
      if (!(v >= 0)) return;
      if (targetStitches().length) F.checkpoint();
      setStitchProp(prop, prop === 'space' ? v : Math.max(0.05, v));
      F.changed();
    });
  }

  function refreshStitch() {
    const sts = targetStitches();
    const first = sts[0];
    const kind = first ? first.kind : S.opts.kind;
    const info = F.stitchRender.kindInfo(kind);
    const pill = $('stitch-target');
    pill.textContent = first ? `Editing ${sts.length} selected` : 'New stitches';
    pill.classList.toggle('accent', !!first);

    const kd = F.kindDefaults(kind);
    const len = first ? F.stitchMm(first, 'len') : kd.len;
    const space = first ? F.stitchMm(first, 'space') : kd.space;
    const w = first ? F.stitchMm(first, 'w') : S.opts.width;
    setVal($('st-len'), fmt(len, 1));
    setVal($('st-len-n'), fmt(len, 2));
    setVal($('st-space'), fmt(space, 1));
    setVal($('st-space-n'), fmt(space, 2));
    setVal($('st-w'), fmt(w, 2));
    setVal($('st-w-n'), fmt(w, 2));
    $('len-label').textContent = info.len || 'Stitch length';
    show($('space-row'), !!info.space);
    $('space-label').textContent = info.space || '';
    $('st-attach').checked = !!S.opts.attach;

    const color = first ? first.color : S.opts.color;
    document.querySelectorAll('.kind').forEach((b) => {
      const on = b.dataset.kind === kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on);
    });
    const key = kind + color;
    if (refreshStitch.key !== key) {
      for (const k of F.stitchRender.KINDS) F.stitchRender.preview(kindCanvases[k.id], k.id, color);
      refreshStitch.key = key;
    }

    let note = '';
    const unmeasured = first ? sts.some((s) => !(F.parentOf(s) && F.parentOf(s).cal)) : false;
    if (unmeasured) note = `On samples that are not measured, millimetres follow the board scale (1 cm = ${fmt(S.doc.pxPerCm, 1)} px).`;
    else if (!first) note = S.tool === 'stitch' ? 'Drag on a sample to stitch. Hold ⇧ for a straight line.' : 'Choose the Stitch tool (S) and drag on a sample.';
    $('stitch-note').textContent = note;
  }

  // ---- Thread panel --------------------------------------------------------

  function threadLabel(t) {
    return t ? `${t.lib} ${t.code}` : '';
  }

  // Use a thread (or a custom colour when t is null) for new stitches and
  // the selected stitches.
  U.chooseThread = function (t, hex) {
    const color = t ? t.hex : C.normHex(hex);
    S.opts.color = color;
    S.opts.thread = t ? { lib: t.lib, code: t.code, name: t.name } : null;
    const sts = targetStitches();
    if (sts.length) {
      F.checkpoint();
      for (const st of sts) {
        st.color = color;
        st.thread = S.opts.thread ? Object.assign({}, S.opts.thread) : null;
      }
      F.changed();
    } else U.refresh();
    savePrefs();
  };

  function initThreadPanel() {
    const custom = $('custom-color');
    custom.addEventListener('input', () => {
      const hex = C.normHex(custom.value);
      S.opts.color = hex;
      S.opts.thread = null;
      const sts = targetStitches();
      if (sts.length) {
        F.beginEdit('color');
        for (const st of sts) {
          st.color = hex;
          st.thread = null;
        }
        F.changed();
      } else U.refresh();
    });
    custom.addEventListener('change', () => {
      F.endEdit();
      U.setPicked(C.normHex(custom.value), 'custom');
      savePrefs();
    });

    if (window.EyeDropper) {
      $('screen-pick').hidden = false;
      $('screen-pick').addEventListener('click', async () => {
        try {
          const r = await new window.EyeDropper().open();
          U.setPicked(C.normHex(r.sRGBHex), 'screen');
        } catch (e) { /* cancelled */ }
      });
    }

    $('sug-close').addEventListener('click', () => {
      S.picked = null;
      renderSuggestions();
    });
    $('sug-exact').addEventListener('click', () => S.picked && U.chooseThread(null, S.picked.hex));
    $('sug-rows').addEventListener('click', (e) => {
      const b = e.target.closest('[data-key]');
      if (b) U.chooseThread(threadByKey(b.dataset.key));
    });

    const search = $('pal-search'), sort = $('pal-sort');
    search.addEventListener('input', renderPalette);
    sort.value = S.opts.sort || 'card';
    sort.addEventListener('change', () => {
      S.opts.sort = sort.value;
      savePrefs();
      renderPalette();
    });
    const pal = $('palette');
    pal.addEventListener('click', (e) => {
      const b = e.target.closest('[data-key]');
      if (b) U.chooseThread(threadByKey(b.dataset.key));
    });
    const hover = $('pal-hover');
    const resetHover = () => (hover.textContent = 'DMC Stranded Cotton · ' + C.threads().length + ' colours');
    pal.addEventListener('mouseover', (e) => {
      const b = e.target.closest('[data-key]');
      if (b) {
        const t = threadByKey(b.dataset.key);
        hover.textContent = `${threadLabel(t)} · ${t.name}`;
      }
    });
    pal.addEventListener('mouseleave', resetHover);
    resetHover();
    renderPalette();

    $('used-list').addEventListener('click', (e) => {
      const li = e.target.closest('[data-ids]');
      if (li) F.select(li.dataset.ids.split(','));
    });
    $('used-copy').addEventListener('click', copyShoppingList);
  }

  let threadMap = null;
  function threadByKey(key) {
    if (!threadMap) threadMap = new Map(C.threads().map((t) => [C.threadKey(t), t]));
    return threadMap.get(key) || null;
  }

  function swatchButton(t, extra) {
    const b = document.createElement('button');
    b.className = 'sw' + (extra ? ' ' + extra : '');
    b.style.background = t.hex;
    b.dataset.key = C.threadKey(t);
    b.title = `${threadLabel(t)} · ${t.name}`;
    b.setAttribute('aria-label', b.title);
    return b;
  }

  function renderPalette() {
    const q = $('pal-search').value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    let list = C.threads().filter((t) => {
      if (!words.length) return true;
      const hay = (t.code + ' ' + t.name).toLowerCase();
      return words.every((w) => t.code.toLowerCase().startsWith(w) || hay.includes(w));
    });
    list = list.slice().sort(C.sorters[S.opts.sort] || C.sorters.card);
    const pal = $('palette');
    pal.textContent = '';
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = 'No DMC colour matches “' + q + '”.';
      pal.appendChild(p);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const t of list) frag.appendChild(swatchButton(t));
    pal.appendChild(frag);
    markActiveSwatch();
  }

  function markActiveSwatch() {
    const key = S.opts.thread ? S.opts.thread.lib + ':' + S.opts.thread.code : '';
    document.querySelectorAll('.sw.on').forEach((b) => b.classList.remove('on'));
    if (key) document.querySelectorAll(`.sw[data-key="${CSS.escape(key)}"]`).forEach((b) => b.classList.add('on'));
  }

  U.setPicked = function (hex, source) {
    S.picked = { hex: C.normHex(hex), source };
    renderSuggestions();
  };

  function renderSuggestions() {
    const box = $('suggest');
    if (!S.picked) {
      show(box, false);
      return;
    }
    show(box, true);
    const { hex, source } = S.picked;
    $('sug-swatch').style.background = hex;
    $('sug-title').textContent =
      (source === 'fabric' ? 'From the fabric' : source === 'screen' ? 'From the screen' : 'Your colour') + ' · ' + hex;
    const rows = $('sug-rows');
    rows.textContent = '';
    for (const row of C.suggest(hex)) {
      if (!row.items.length) continue;
      const div = document.createElement('div');
      div.className = 'sug-row';
      const lab = document.createElement('div');
      lab.className = 'sug-label';
      lab.textContent = row.label;
      lab.title = row.hint;
      const chips = document.createElement('div');
      chips.className = 'chips';
      for (const { t } of row.items) {
        const b = swatchButton(t, 'chip');
        const code = document.createElement('span');
        code.textContent = t.code;
        code.style.color = C.isDark(t.hex) ? '#fff' : '#222';
        b.appendChild(code);
        chips.appendChild(b);
      }
      div.append(lab, chips);
      rows.appendChild(div);
    }
    markActiveSwatch();
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  let usedVersion = -1;
  function refreshThread() {
    const first = targetStitches()[0];
    const color = first ? first.color : S.opts.color;
    const thread = first ? first.thread : S.opts.thread;
    $('cur-swatch').style.background = color;
    if (thread) {
      $('cur-name').textContent = `${thread.lib} ${thread.code}`;
      $('cur-sub').textContent = thread.name;
    } else {
      const n = C.nearest(C.hexToLab(color), 1)[0];
      $('cur-name').textContent = 'Custom colour ' + color;
      $('cur-sub').textContent = n ? `Closest: ${threadLabel(n.t)} ${n.t.name}` : '';
    }
    const custom = $('custom-color');
    if (document.activeElement !== custom) custom.value = color.toLowerCase();
    markActiveSwatch();

    if (usedVersion !== S.version) {
      usedVersion = S.version;
      renderUsed();
    }
  }

  function usedGroups() {
    const groups = new Map();
    for (const st of S.doc.stitches) {
      const key = st.thread ? st.thread.lib + ':' + st.thread.code : st.color;
      if (!groups.has(key)) groups.set(key, { key, thread: st.thread, color: st.color, ids: [] });
      groups.get(key).ids.push(st.id);
    }
    return [...groups.values()];
  }

  function renderUsed() {
    const groups = usedGroups();
    $('used-count').textContent = groups.length ? '(' + groups.length + ')' : '';
    const ul = $('used-list');
    ul.textContent = '';
    if (!groups.length) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.textContent = 'No stitches yet.';
      ul.appendChild(li);
    }
    for (const g of groups) {
      const li = document.createElement('li');
      li.dataset.ids = g.ids.join(',');
      li.title = 'Select these stitches';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = g.color;
      const txt = document.createElement('span');
      txt.className = 'grow';
      if (g.thread) txt.textContent = `${g.thread.lib} ${g.thread.code} ${g.thread.name}`;
      else {
        const n = C.nearest(C.hexToLab(g.color), 1)[0];
        txt.textContent = `Custom ${g.color}` + (n ? ` (≈ ${threadLabel(n.t)})` : '');
      }
      const cnt = document.createElement('span');
      cnt.className = 'muted small';
      cnt.textContent = '×' + g.ids.length;
      li.append(sw, txt, cnt);
      ul.appendChild(li);
    }
    $('used-copy').hidden = !groups.length;
  }

  function copyShoppingList() {
    const lines = usedGroups().map((g) => {
      if (g.thread) return `${g.thread.lib} ${g.thread.code} – ${g.thread.name}`;
      const n = C.nearest(C.hexToLab(g.color), 1)[0];
      return `Custom ${g.color}` + (n ? ` (closest ${threadLabel(n.t)} – ${n.t.name})` : '');
    });
    const text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => F.toast('Shopping list copied.'),
        () => F.toast('Could not copy. ' + text)
      );
    } else F.toast(text, 8000);
  }

  // ---- Board panel ---------------------------------------------------------

  let linkSnap = null;

  function initBoardPanel() {
    const wrap = $('bg-swatches');
    for (const [hex, name] of BG_PRESETS) {
      const b = document.createElement('button');
      b.className = 'bg-sw';
      b.style.background = hex;
      b.title = name;
      b.setAttribute('aria-label', name + ' background');
      b.dataset.hex = hex;
      b.addEventListener('click', () => {
        F.checkpoint();
        S.doc.bg = hex;
        F.changed();
      });
      wrap.appendChild(b);
    }
    const bgc = $('bg-custom');
    bgc.addEventListener('input', () => {
      F.beginEdit('bg');
      S.doc.bg = C.normHex(bgc.value);
      F.changed();
    });
    bgc.addEventListener('change', () => F.endEdit());

    $('opt-grid').addEventListener('change', (e) => {
      F.checkpoint();
      S.doc.grid = e.target.checked;
      F.changed();
    });
    $('opt-shadows').addEventListener('change', (e) => {
      F.checkpoint();
      S.doc.shadows = e.target.checked;
      F.changed();
    });

    const r = $('px-cm'), n = $('px-cm-n');
    r.addEventListener('input', () => {
      if (!linkSnap) {
        F.beginEdit('pxcm');
        linkSnap = F.linkScaleSnapshot();
      }
      F.applyLinkScale(linkSnap, pxFromSlider(parseFloat(r.value)));
      F.changed();
    });
    r.addEventListener('change', () => {
      linkSnap = null;
      F.endEdit();
    });
    n.addEventListener('change', () => {
      const v = parseFloat(n.value);
      if (!(v > 0)) return;
      F.checkpoint();
      F.applyLinkScale(F.linkScaleSnapshot(), v);
      F.changed();
    });

    $('fit-all').addEventListener('click', () => F.fitView(false));
    $('clear-board').addEventListener('click', () => {
      if (!S.doc.clips.length && !S.doc.stitches.length) return;
      if (!confirm('Remove all samples and stitches from the board? (You can undo this.)')) return;
      F.checkpoint();
      S.doc.clips = [];
      S.doc.stitches = [];
      S.sel.clear();
      F.changed();
    });
  }

  function refreshBoard() {
    document.querySelectorAll('.bg-sw').forEach((b) => b.classList.toggle('on', b.dataset.hex === C.normHex(S.doc.bg)));
    const bgc = $('bg-custom');
    if (document.activeElement !== bgc) bgc.value = C.normHex(S.doc.bg).toLowerCase();
    $('opt-grid').checked = !!S.doc.grid;
    $('opt-shadows').checked = S.doc.shadows !== false;
    if (!linkSnap) setVal($('px-cm'), Math.round(sliderFromPx(S.doc.pxPerCm)));
    setVal($('px-cm-n'), fmt(S.doc.pxPerCm, 1));
    const linked = F.linkedClips();
    const measured = linked.filter((c) => c.cal).length;
    let info;
    if (!linked.length) info = 'Nothing is linked yet. Measure a sample, or tick “Link size” on samples you matched by eye. Linked samples resize together.';
    else {
      info = `${linked.length} linked sample${linked.length === 1 ? '' : 's'} resize${linked.length === 1 ? 's' : ''} with this slider`;
      info += measured ? ` (${measured} measured, shown at real size).` : '.';
    }
    $('linked-info').textContent = info;
  }

  // ---- Measure popover -----------------------------------------------------

  let measureCtx = null;

  function initMeasure() {
    const form = $('measure-pop');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = parseFloat($('measure-len').value);
      if (!(v > 0) || !measureCtx) return;
      const unit = $('measure-unit').value;
      const cm = unit === 'mm' ? v / 10 : unit === 'in' ? v * 2.54 : v;
      const { clip, la, lb } = measureCtx;
      const px = G.dist(la, lb) / cm;
      const live = F.clipById(clip.id);
      U.closeMeasure();
      if (!live) return;
      const n = F.calibrate(live, px, { line: [la, lb], value: fmt(v, 2), unit: unit === 'in' ? 'in' : unit });
      F.toast(n ? `Real size set — now in proportion with ${n} linked sample${n > 1 ? 's' : ''}.` : 'Real size set. Measure your other samples too and they will match this one.', 4500);
    });
    $('measure-cancel').addEventListener('click', () => U.closeMeasure());
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        U.closeMeasure();
      }
    });
    $('measure-unit').addEventListener('change', (e) => {
      S.opts.measureUnit = e.target.value;
    });
  }

  U.askMeasure = function (clip, la, lb, mid) {
    measureCtx = { clip, la, lb };
    const pop = $('measure-pop');
    pop.hidden = false;
    const vs = F.viewSize();
    const w = pop.offsetWidth || 240, h = pop.offsetHeight || 120;
    const x = Math.max(8, Math.min(vs.w - w - 8, mid[0] - w / 2));
    const y = Math.max(8, Math.min(vs.h - h - 8, mid[1] + 24));
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    $('measure-len').value = '';
    $('measure-unit').value = S.opts.measureUnit || 'cm';
    setTimeout(() => $('measure-len').focus(), 0);
  };

  U.measureOpen = () => !$('measure-pop').hidden;

  U.closeMeasure = function () {
    measureCtx = null;
    $('measure-pop').hidden = true;
    if (F.input) F.input.measure = null;
    F.requestRender();
  };

  // ---- Files ---------------------------------------------------------------

  U.saveFile = async function () {
    if (!S.doc.clips.length && !S.doc.stitches.length) {
      F.toast('The board is empty — nothing to save yet.');
      return;
    }
    const blob = await F.store.exportProject(S.doc, S.images);
    F.store.download(blob, `fabrica-${F.store.stamp()}.json`);
  };

  U.openFile = () => $('file-open').click();

  async function loadProjectFile(file) {
    let data;
    try {
      data = await F.store.parseProject(file);
    } catch (e) {
      F.toast(e.message && e.message.includes('Fabrica') ? e.message : 'Could not open that file.');
      return;
    }
    if ((S.doc.clips.length || S.doc.stitches.length) && !confirm('Replace the current board with the one in this file? (You can undo this.)')) return;
    for (const [id, blob] of data.images) {
      if (S.images.has(id)) continue;
      try {
        S.images.set(id, await F.loadImageRecord(blob));
      } catch (e) {
        console.warn('Could not load image', id, e);
      }
    }
    F.checkpoint();
    S.doc = Object.assign(F.newDoc(), data.doc);
    S.sel.clear();
    F.changed();
    F.fitView(false);
  }

  U.exportPng = function () {
    const onlySel = S.sel.size > 0;
    const cv = F.render.exportCanvas(onlySel);
    if (!cv) {
      F.toast('The board is empty — nothing to export yet.');
      return;
    }
    cv.toBlob((blob) => F.store.download(blob, `fabrica-${F.store.stamp()}.png`), 'image/png');
    if (onlySel) F.toast('Exported the selection. Deselect (Esc) to export everything.');
  };

  U.copyPng = function () {
    const onlySel = S.sel.size > 0;
    const cv = F.render.exportCanvas(onlySel);
    if (!cv) {
      F.toast('The board is empty — nothing to copy yet.');
      return;
    }
    if (!navigator.clipboard || !window.ClipboardItem) {
      F.toast('This browser cannot copy pictures. Use Download PNG instead.');
      return;
    }
    const blobP = new Promise((res) => cv.toBlob(res, 'image/png'));
    navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blobP })]).then(
      () => F.toast(onlySel ? 'Selection copied as a picture.' : 'Board copied as a picture.'),
      () => F.toast('Could not copy the picture. Use Download PNG instead.')
    );
  };

  U.showHelp = () => $('help').showModal();

  function savePrefs() {
    clearTimeout(savePrefs.t);
    savePrefs.t = setTimeout(() => F.store.savePrefs(F.prefs()).catch(() => {}), 300);
  }
  U.savePrefs = savePrefs;
})(window.Fabrica = window.Fabrica || {});
