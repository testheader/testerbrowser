// Page-context scripts injected via WebFrameMain.executeJavaScript() to
// collect and restore per-frame state for session snapshot export/import.
// Kept as string constants (rather than .ts source) because they run inside
// the page's own JS context, not the Electron main process — tsc never sees
// them, so there's no benefit to a separate compiled file.

// Injected once per session (via CDP Page.addScriptToEvaluateOnNewDocument,
// see sessionManager.ts's createSession) so it runs before any page script on
// every navigation in that session, including the reload snapshot import
// triggers. Real React DevTools support is normally provided by the
// DevTools *browser extension*, which TesterBrowser doesn't install — so
// without this stub, window.__REACT_DEVTOOLS_GLOBAL_HOOK__ never exists and
// React never registers with it, and the reactState capture below silently
// finds nothing on virtually every page. This stub implements only the
// handful of hook methods react-reconciler actually calls (inject,
// onCommitFiberRoot, ...), enough to track each renderer's current fiber
// roots — not the full DevTools backend (which also isn't publicly
// published as an installable script and implements a much larger surface
// we don't need).
export const REACT_HOOK_STUB_SCRIPT = `
(function() {
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;
  var fiberRoots = new Map();
  var renderers = new Map();
  var nextRendererID = 1;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: renderers,
    checkDCE: function() {},
    inject: function(renderer) {
      var id = nextRendererID++;
      renderers.set(id, renderer);
      fiberRoots.set(id, new Set());
      return id;
    },
    onScheduleFiberRoot: function() {},
    onCommitFiberRoot: function(id, root) {
      var set = fiberRoots.get(id);
      if (set) set.add(root);
    },
    onCommitFiberUnmount: function() {},
    getFiberRoots: function(id) {
      return Array.from(fiberRoots.get(id) || []);
    },
  };
})();
`;

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
//   - a best-effort dump of React component state via the REACT_HOOK_STUB_SCRIPT
//     hook above, when present. On import, buildRestoreFrameScript attempts
//     to write it back into the freshly-mounted tree (see there for how and
//     its limits) — this is unstable, undocumented React internals, not a
//     supported API, so it can silently do nothing on a page it can't
//     confidently match or on a future React version that changes shape.
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
          if (fiber.stateNode && fiber.stateNode.state !== undefined && fiber.stateNode.state !== null) {
            nodes.push({ path: path.concat(name).join(' > '), kind: 'class', state: serialize(fiber.stateNode.state, 0) });
          } else if (fiber.memoizedState) {
            const hooks = [];
            let h = fiber.memoizedState;
            let guard = 0;
            while (h && guard++ < 50) { hooks.push(serialize(h.memoizedState, 0)); h = h.next; }
            if (hooks.length) nodes.push({ path: path.concat(name).join(' > '), kind: 'function', hooks });
          }
        }
        if (fiber.child) visit(fiber.child, path.concat(name || '?'));
        if (fiber.sibling) visit(fiber.sibling, path);
      };
      for (const rendererID of hook.renderers.keys()) {
        const roots = hook.getFiberRoots(rendererID) || [];
        for (const root of roots) visit(root.current, []);
      }
      if (nodes.length) {
        reactState = { note: 'Best-effort dump via a minimal DevTools hook stub. Import attempts to restore useState-backed hooks and class component state by matching component path; anything else (useReducer, custom hooks, unmatched paths) is left alone.', nodes };
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

  // Best-effort React state restore. Requires the same REACT_HOOK_STUB_SCRIPT
  // hook (present from page-start, so React has already registered its fresh
  // fiber roots by the time this runs). We re-walk the newly-mounted tree
  // with the identical traversal used at capture, match nodes by the same
  // "Component > Component" path string, and only ever touch state through
  // APIs the component itself would use:
  //   - class components: instance.setState(...) — public API.
  //   - hooks: the hook's own queue.dispatch (the exact function useState
  //     returned as the setter) — but ONLY when queue.lastRenderedReducer
  //     looks like React's built-in basicStateReducer, so we don't feed a
  //     raw value into a useReducer hook's dispatch (which expects an
  //     action, not a value, and would run the app's own reducer against
  //     it). That name check is itself unreliable under minification, so
  //     production builds will often just skip hook restoration — reported
  //     as a warning, never a crash or corrupted state.
  // Path matching is inherently ambiguous for sibling components that share
  // a name/position (e.g. list items) — first match wins, extras are
  // reported below.
  if (DATA.reactState && Array.isArray(DATA.reactState.nodes) && DATA.reactState.nodes.length) {
    try {
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook || !hook.getFiberRoots) {
        warnings.push('reactState: no React DevTools hook present on the restored page — nothing restored');
      } else {
        const nodes = DATA.reactState.nodes;
        const consumed = new Array(nodes.length).fill(false);
        let restoredValues = 0;
        let matchedComponents = 0;
        const visit = (fiber, path) => {
          if (!fiber) return;
          const name = (fiber.type && (fiber.type.displayName || fiber.type.name)) || (typeof fiber.type === 'string' ? fiber.type : null);
          if (name) {
            const fullPath = path.concat(name).join(' > ');
            const idx = nodes.findIndex((n, i) => !consumed[i] && n.path === fullPath);
            if (idx >= 0) {
              consumed[idx] = true;
              matchedComponents++;
              const match = nodes[idx];
              try {
                if (match.kind === 'class' && fiber.stateNode && typeof fiber.stateNode.setState === 'function') {
                  fiber.stateNode.setState(match.state);
                  restoredValues++;
                } else if (match.kind === 'function' && Array.isArray(match.hooks) && fiber.memoizedState) {
                  let h = fiber.memoizedState;
                  let i = 0;
                  while (h) {
                    const value = match.hooks[i];
                    if (value !== undefined && h.queue && typeof h.queue.dispatch === 'function' &&
                        h.queue.lastRenderedReducer && h.queue.lastRenderedReducer.name === 'basicStateReducer') {
                      h.queue.dispatch(value);
                      restoredValues++;
                    }
                    h = h.next; i++;
                  }
                }
              } catch (e) {
                warnings.push('reactState ' + fullPath + ': ' + (e && e.message || String(e)));
              }
            }
          }
          if (fiber.child) visit(fiber.child, path.concat(name || '?'));
          if (fiber.sibling) visit(fiber.sibling, path);
        };
        for (const rendererID of hook.renderers.keys()) {
          const roots = hook.getFiberRoots(rendererID) || [];
          for (const root of roots) visit(root.current, []);
        }
        warnings.push('reactState: restored ' + restoredValues + ' hook/state value(s) across ' + matchedComponents + ' matched component(s) of ' + nodes.length + ' captured (best-effort, see docs)');
      }
    } catch (e) {
      warnings.push('reactState restore: ' + (e && e.message || String(e)));
    }
  }

  return JSON.stringify({ warnings });
})()
`;
}
