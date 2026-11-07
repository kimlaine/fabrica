// Persistence: IndexedDB autosave, project files, downloads.
(function (F) {
  'use strict';

  const ST = (F.store = {});
  const DB_NAME = 'fabrica';
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB not available'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(storeNames, mode, fn) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeNames, mode);
          let result;
          Promise.resolve(fn(t)).then((r) => (result = r));
          t.oncomplete = () => resolve(result);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Returns { doc, prefs, images: Map(id → Blob) } or null.
  ST.load = async function () {
    const db = await openDb();
    const t = db.transaction(['kv', 'images'], 'readonly');
    const docJson = await reqP(t.objectStore('kv').get('doc'));
    const prefs = await reqP(t.objectStore('kv').get('prefs'));
    if (!docJson) return { doc: null, prefs: prefs || null, images: new Map() };
    const doc = JSON.parse(docJson);
    const ids = new Set(doc.clips.map((c) => c.imageId));
    const images = new Map();
    const keys = await reqP(t.objectStore('images').getAllKeys());
    for (const id of keys) {
      if (ids.has(id)) images.set(id, await reqP(t.objectStore('images').get(id)));
    }
    // Drop images nothing refers to any more.
    const orphans = keys.filter((k) => !ids.has(k));
    if (orphans.length) {
      tx(['images'], 'readwrite', (tr) => orphans.forEach((k) => tr.objectStore('images').delete(k))).catch(() => {});
    }
    return { doc, prefs: prefs || null, images };
  };

  const savedImages = new Set();
  ST.markImageSaved = (id) => savedImages.add(id);

  ST.save = function (doc, images, prefs) {
    const json = JSON.stringify(doc);
    const needed = doc.clips.map((c) => c.imageId).filter((id) => !savedImages.has(id) && images.has(id));
    return tx(['kv', 'images'], 'readwrite', (t) => {
      t.objectStore('kv').put(json, 'doc');
      if (prefs) t.objectStore('kv').put(prefs, 'prefs');
      for (const id of new Set(needed)) t.objectStore('images').put(images.get(id).blob, id);
    }).then(() => needed.forEach((id) => savedImages.add(id)));
  };

  ST.savePrefs = (prefs) => tx(['kv'], 'readwrite', (t) => t.objectStore('kv').put(prefs, 'prefs'));

  // ---- Files ---------------------------------------------------------------

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(url) {
    const [head, data] = url.split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(data);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  ST.download = function (blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  ST.stamp = function () {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  };

  ST.exportProject = async function (doc, images) {
    const out = { app: 'fabrica', version: 1, doc, images: {} };
    for (const c of doc.clips) {
      if (!out.images[c.imageId] && images.has(c.imageId)) {
        out.images[c.imageId] = await blobToDataUrl(images.get(c.imageId).blob);
      }
    }
    return new Blob([JSON.stringify(out)], { type: 'application/json' });
  };

  ST.parseProject = async function (file) {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== 'fabrica' || !data.doc) throw new Error('This is not a Fabrica board file.');
    const images = new Map();
    for (const [id, url] of Object.entries(data.images || {})) images.set(id, dataUrlToBlob(url));
    return { doc: data.doc, images };
  };
})(window.Fabrica = window.Fabrica || {});
