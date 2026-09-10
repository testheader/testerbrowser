// Page-context scripts injected via WebFrameMain.executeJavaScript() to
// collect and restore per-frame state for session snapshot export/import.
// Kept as string constants (rather than .ts source) because they run inside
// the page's own JS context, not the Electron main process — tsc never sees
// them, so there's no benefit to a separate compiled file.

// Executed once per frame (main frame + every same-page iframe) during
// export. Returns a JSON string (frames can't return arbitrary structured
// data across the executeJavaScript boundary reliably, so we stringify).
//
// Collects, best-effort, with every step isolated so one failing piece
// (e.g. a locked IndexedDB) doesn't drop the rest:
//   - localStorage / sessionStorage
//   - IndexedDB databases + object stores + records
//   - visible form field values (skips password inputs)
//   - scroll position and history.state
//   - a diagnostic-only dump of React component state via the React
//     DevTools global hook, when present. This is never restored on
//     import — there's no supported way to feed state back into arbitrary
//     React components from outside the app, so it's exported purely so a
//     tester can inspect what a component's state looked like at capture
//     time.
export const COLLECT_FRAME_SCRIPT = `
(async function() {
  const warnings = [];
  const safe = (fn, label) => { try { return fn(); } catch (e) { warnings.push(label + ': ' + (e && e.message || String(e))); return undefined; } };

  const localStorageData = safe(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])), 'localStorage');
  const sessionStorageData = safe(() => Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])), 'sessionStorage');

  const fields = safe(() => {
    const out = [];
    document.querySelectorAll('input, textarea, select').forEach((el) => {
      if (el.type === 'password') return;
      let sel = null;
      if (el.id) sel = '#' + CSS.escape(el.id);
      else if (el.name) sel = el.tagName.toLowerCase() + '[name="' + el.name.replace(/"/g, '\\\\"') + '"]';
      if (!sel) return;
      if (el.type === 'checkbox' || el.type === 'radio') out.push({ sel, kind: 'checked', checked: el.checked });
      else out.push({ sel, kind: 'value', value: el.value });
    });
    return out;
  }, 'formFields') || [];

  const scroll = safe(() => ({ x: window.scrollX, y: window.scrollY }), 'scroll');
  const historyState = safe(() => window.history.state, 'historyState');

  const indexedDBData = {};
  if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
    try {
      const dbInfos = await indexedDB.databases();
      for (const info of dbInfos) {
        if (!info.name) continue;
        try {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(info.name);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const stores = {};
          for (const storeName of Array.from(db.objectStoreNames)) {
            try {
              const tx = db.transaction(storeName, 'readonly');
              const store = tx.objectStore(storeName);
              const keyPath = store.keyPath;
              const autoIncrement = store.autoIncrement;
              const records = await new Promise((resolve, reject) => {
                const out = [];
                const cursorReq = store.openCursor();
                cursorReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) { out.push({ key: cursor.key, value: cursor.value }); cursor.continue(); }
                  else resolve(out);
                };
                cursorReq.onerror = () => reject(cursorReq.error);
              });
              stores[storeName] = { keyPath, autoIncrement, records };
            } catch (e) {
              warnings.push('IndexedDB store ' + info.name + '.' + storeName + ': ' + (e && e.message || String(e)));
            }
          }
          indexedDBData[info.name] = { version: db.version, stores };
          db.close();
        } catch (e) {
          warnings.push('IndexedDB database ' + info.name + ': ' + (e && e.message || String(e)));
        }
      }
    } catch (e) {
      warnings.push('IndexedDB: ' + (e && e.message || String(e)));
    }
  }

  let reactState;
  try {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook && hook.renderers && hook.renderers.size > 0 && hook.getFiberRoots) {
      const seen = new Set();
      const serialize = (v, depth) => {
        if (depth > 6) return '[max depth]';
        if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
        if (seen.has(v)) return '[circular]';
        seen.add(v);
        if (Array.isArray(v)) return v.map((x) => serialize(x, depth + 1));
        if (typeof Node !== 'undefined' && v instanceof Node) return '[DOMNode]';
        const out = {};
        for (const k of Object.keys(v)) {
          try { out[k] = serialize(v[k], depth + 1); } catch { /* unserializable field, skip */ }
        }
        return out;
      };
      const nodes = [];
      const visit = (fiber, path) => {
        if (!fiber || nodes.length > 500) return;
        const name = (fiber.type && (fiber.type.displayName || fiber.type.name)) || (typeof fiber.type === 'string' ? fiber.type : null);
        if (name) {
          let state;
          if (fiber.stateNode && fiber.stateNode.state !== undefined && fiber.stateNode.state !== null) {
            state = serialize(fiber.stateNode.state, 0);
          } else if (fiber.memoizedState) {
            const hooks = [];
            let h = fiber.memoizedState;
            let guard = 0;
            while (h && guard++ < 50) { hooks.push(serialize(h.memoizedState, 0)); h = h.next; }
            if (hooks.length) state = hooks;
          }
          if (state !== undefined) nodes.push({ path: path.concat(name).join(' > '), state });
        }
        if (fiber.child) visit(fiber.child, path.concat(name || '?'));
        if (fiber.sibling) visit(fiber.sibling, path);
      };
      for (const rendererID of hook.renderers.keys()) {
        const roots = hook.getFiberRoots(rendererID) || [];
        for (const root of roots) visit(root.current, []);
      }
      if (nodes.length) {
        reactState = { note: 'Best-effort diagnostic dump via the React DevTools hook. Not restored on import.', nodes };
      }
    }
  } catch (e) {
    warnings.push('reactState: ' + (e && e.message || String(e)));
  }

  return JSON.stringify({
    url: location.href,
    localStorage: localStorageData,
    sessionStorage: sessionStorageData,
    indexedDB: indexedDBData,
    fields,
    scroll,
    historyState,
    reactState,
    warnings,
  });
})()
`;

// Executed once per matched frame during import. \`data\` is the FrameSnapshot
// for this frame, already validated and JSON-serializable by the caller.
export function buildRestoreFrameScript(data: unknown): string {
  return `
(async function() {
  const DATA = ${JSON.stringify(data)};
  const warnings = [];

  if (DATA.localStorage && typeof DATA.localStorage === 'object') {
    try {
      localStorage.clear();
      for (const [k, v] of Object.entries(DATA.localStorage)) localStorage.setItem(k, v);
    } catch (e) { warnings.push('localStorage: ' + (e && e.message || String(e))); }
  }
  if (DATA.sessionStorage && typeof DATA.sessionStorage === 'object') {
    try {
      sessionStorage.clear();
      for (const [k, v] of Object.entries(DATA.sessionStorage)) sessionStorage.setItem(k, v);
    } catch (e) { warnings.push('sessionStorage: ' + (e && e.message || String(e))); }
  }

  if (DATA.indexedDB && typeof DATA.indexedDB === 'object' && typeof indexedDB !== 'undefined') {
    for (const [dbName, dbSnap] of Object.entries(DATA.indexedDB)) {
      try {
        const neededStores = Object.keys(dbSnap.stores || {});
        let existing;
        try {
          existing = await new Promise((resolve, reject) => {
            const req = indexedDB.open(dbName);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
        } catch (e) { existing = null; }
        const missing = existing ? neededStores.filter((s) => !existing.objectStoreNames.contains(s)) : neededStores;
        let db;
        if (existing && missing.length === 0) {
          db = existing;
        } else {
          const nextVersion = (existing ? existing.version : 0) + 1;
          if (existing) existing.close();
          db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(dbName, nextVersion);
            req.onupgradeneeded = () => {
              const upgradeDb = req.result;
              for (const storeName of missing) {
                const storeSnap = dbSnap.stores[storeName];
                upgradeDb.createObjectStore(storeName, { keyPath: storeSnap.keyPath || undefined, autoIncrement: !!storeSnap.autoIncrement });
              }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
        }
        for (const [storeName, storeSnap] of Object.entries(dbSnap.stores || {})) {
          try {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            store.clear();
            for (const rec of storeSnap.records || []) {
              if (store.keyPath) store.put(rec.value);
              else store.put(rec.value, rec.key);
            }
            await new Promise((resolve, reject) => {
              tx.oncomplete = () => resolve(undefined);
              tx.onerror = () => reject(tx.error);
            });
          } catch (e) {
            warnings.push('IndexedDB restore ' + dbName + '.' + storeName + ': ' + (e && e.message || String(e)));
          }
        }
        db.close();
      } catch (e) {
        warnings.push('IndexedDB restore ' + dbName + ': ' + (e && e.message || String(e)));
      }
    }
  }

  if (DATA.historyState !== undefined) {
    try { window.history.replaceState(DATA.historyState, '', location.href); } catch (e) { warnings.push('historyState: ' + (e && e.message || String(e))); }
  }
  if (DATA.scroll) {
    try { window.scrollTo(DATA.scroll.x, DATA.scroll.y); } catch (e) { warnings.push('scroll: ' + (e && e.message || String(e))); }
  }
  if (Array.isArray(DATA.fields)) {
    for (const f of DATA.fields) {
      try {
        const el = document.querySelector(f.sel);
        if (!el) continue;
        if (f.kind === 'checked') el.checked = !!f.checked;
        else el.value = f.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) { warnings.push('field ' + f.sel + ': ' + (e && e.message || String(e))); }
    }
  }

  return JSON.stringify({ warnings });
})()
`;
}
