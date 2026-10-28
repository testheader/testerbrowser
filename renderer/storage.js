/* global testerBrowser */
import { cookieMatchesDomain, formatRelativeExpiry } from './utils.js';
import { getActiveId } from './tabs.js';
import { getActiveConsoleTab } from './console-tabs.js';
import { isConsoleVisible } from './layout.js';

// domainFilterActive (the Storage tab's "only cookies relevant to this page"
// toggle) is used only within this file.
let domainFilterActive = true;
let autoRefreshOn = false;
let autoRefreshTimer = null;

// The last fetch's data, kept in memory so the filter input can re-render
// without any further IPC round-trip — see fetchStorageData()/renderStoragePanel().
let cache = null;

// #304: the section nav shows one section at a time.
const SECTIONS = ['cookies', 'local', 'session', 'idb', 'permissions'];
let activeSection = 'cookies';
// Add / Clear all handlers of whichever section is currently rendered (null
// for the read-only ones); the toolbar buttons call through these.
let sectionActions = { add: null, clear: null };

const ROW_ERROR_TTL_MS = 6000;

function formatCookieExpiry(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSameSite(ss) {
  if (ss === 'no_restriction') return 'None';
  if (!ss || ss === 'unspecified') return '—';
  return ss.charAt(0).toUpperCase() + ss.slice(1);
}

function flashCopied(td) {
  td.classList.add('flash-copied');
  setTimeout(() => td.classList.remove('flash-copied'), 500);
}

async function copyToClipboard(text) {
  await testerBrowser.clipboard.write(text);
}

// Inserts a transient error message right after `afterRow` inside the same
// table, replacing any earlier one in that table. Used for a failed cookie
// add/edit so the row that caused it stays visible instead of vanishing —
// removed automatically, or by the next real render.
function showRowError(afterRow, colSpan, message) {
  const table = afterRow.closest('table');
  if (!table) return;
  table.querySelectorAll('.storage-row-error').forEach((el) => el.remove());
  const tr = document.createElement('tr');
  tr.className = 'storage-row-error';
  const td = document.createElement('td');
  td.colSpan = colSpan;
  td.textContent = message;
  tr.appendChild(td);
  afterRow.after(tr);
  setTimeout(() => tr.remove(), ROW_ERROR_TTL_MS);
}

function revertValueCell(td, text) {
  td.innerHTML = '';
  td.style.overflow = 'hidden';
  td.textContent = text;
}

// ── Fetch (real IPC round-trip) vs. render (pure, in-memory) ──
//
// Every real state change (tab/session switch, explicit refresh, a
// successful add/edit/delete, an auto-refresh tick) goes through
// fetchStorageData(). Everything else — typing in the filter, toggling
// "Current domain", cancelling an in-progress edit — re-renders from
// `cache` via renderStoragePanel() with zero IPC calls.

export async function fetchStorageData() {
  const sessionId = getActiveId();
  if (!sessionId) return;

  const urlbarVal = /** @type {HTMLInputElement} */ (document.getElementById('urlbar')).value;
  let currentHostname = '';
  try {
    if (urlbarVal && urlbarVal.startsWith('http')) currentHostname = new URL(urlbarVal).hostname;
  } catch {}

  const [cookies, ls, ss, idb, loadedDomains, permissions] = await Promise.all([
    testerBrowser.sessions.getCookies(sessionId),
    testerBrowser.sessions.getLocalStorage(sessionId),
    testerBrowser.sessions.getSessionStorage(sessionId),
    testerBrowser.sessions.getIndexedDB(sessionId),
    testerBrowser.sessions.getLoadedDomains(sessionId),
    testerBrowser.permission.list(sessionId),
  ]);

  cache = { sessionId, cookies, ls, ss, idb, loadedDomains, currentHostname, permissions };
  renderStoragePanel();
}

// Kept as the exported name every existing caller (tabs.js, console-tabs.js,
// ipc-events.js, refreshStorageBtn, …) already uses for "the storage panel
// needs a real refresh."
export const loadStoragePanel = fetchStorageData;

function updateStorageNav(counts) {
  for (const name of SECTIONS) {
    const item = document.querySelector(`#storageNav [data-section="${name}"]`);
    if (!item) continue;
    item.classList.toggle('active', name === activeSection);
    item.setAttribute('aria-current', name === activeSection ? 'true' : 'false');
    item.querySelector('.storage-nav-count').textContent = counts ? String(counts[name]) : '';
  }
  const addBtn = /** @type {HTMLButtonElement} */ (document.getElementById('storageAddBtn'));
  const clearBtn = /** @type {HTMLButtonElement} */ (document.getElementById('storageClearBtn'));
  addBtn.hidden = !sectionActions.add;
  clearBtn.hidden = !sectionActions.clear;
}

export function renderStoragePanel() {
  const panel = document.getElementById('storagePanelContent');
  if (!cache || cache.sessionId !== getActiveId()) {
    sectionActions = { add: null, clear: null };
    updateStorageNav(null);
    panel.innerHTML = '<div class="storage-empty">Loading…</div>';
    return;
  }
  const { sessionId, cookies, ls, ss, idb, loadedDomains, currentHostname, permissions } = cache;
  const filterText = /** @type {HTMLInputElement} */ (document.getElementById('storageFilter')).value.toLowerCase();

  panel.innerHTML = '';
  sectionActions = { add: null, clear: null };
  if (activeSection === 'cookies') sectionActions = renderCookiesSection(panel, sessionId, cookies, filterText, loadedDomains, currentHostname);
  else if (activeSection === 'local') sectionActions = renderLocalStorageSection(panel, sessionId, ls, filterText);
  else if (activeSection === 'session') renderSessionStorageSection(panel, ss, filterText);
  else if (activeSection === 'idb') renderIndexedDBSection(panel, idb, filterText);
  else renderPermissionsSection(panel, sessionId, permissions || [], filterText);

  updateStorageNav({
    cookies: cookies.length,
    local: Object.keys(ls).length,
    session: Object.keys(ss).length,
    idb: Object.keys(idb || {}).length,
    permissions: (permissions || []).length,
  });
}

// ── Cookies ──

function renderCookiesSection(panel, sessionId, cookies, filterText, loadedDomains, currentHostname) {
  const textFiltered = filterText
    ? cookies.filter(c =>
        (c.domain || '').toLowerCase().includes(filterText) ||
        c.name.toLowerCase().includes(filterText) ||
        c.value.toLowerCase().includes(filterText))
    : cookies;

  const filteredCookies = domainFilterActive
    ? textFiltered.filter(c =>
        cookieMatchesDomain(c, currentHostname) ||
        loadedDomains.some(d => cookieMatchesDomain(c, d)))
    : textFiltered;

  const cookieTable = document.createElement('table');
  cookieTable.className = 'storage-table storage-cookie-table';
  cookieTable.innerHTML = '<colgroup><col style="width:170px"><col><col style="width:190px"><col style="width:40px"><col style="width:96px"><col style="width:200px"><col style="width:36px"></colgroup>' +
    '<thead><tr><th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>Expires</th><th>Flags</th><th></th></tr></thead>';
  const cookieTbody = document.createElement('tbody');

  const add = () => {
    if (cookieTable.querySelector('.storage-add-row')) return;
    const addTr = document.createElement('tr');
    addTr.className = 'storage-add-row';

    const nameInput = document.createElement('input');
    nameInput.className   = 'ls-edit-input';
    nameInput.placeholder = 'name';
    const valInput = document.createElement('input');
    valInput.className   = 'ls-edit-input';
    valInput.placeholder = 'value';
    const domainInput = document.createElement('input');
    domainInput.className   = 'ls-edit-input';
    domainInput.placeholder = 'domain';
    domainInput.value       = currentHostname || '';
    const pathInput = document.createElement('input');
    pathInput.className   = 'ls-edit-input';
    pathInput.placeholder = 'path';
    pathInput.value       = '/';
    const expiryInput = document.createElement('input');
    expiryInput.type  = 'datetime-local';
    expiryInput.className = 'ls-edit-input';
    expiryInput.title = 'Leave blank for a session cookie';
    const sameSiteSelect = document.createElement('select');
    [['', 'Default'], ['lax', 'Lax'], ['strict', 'Strict'], ['no_restriction', 'None']]
      .forEach(([value, label]) => {
        const opt = document.createElement('option');
        opt.value = value; opt.textContent = label;
        sameSiteSelect.appendChild(opt);
      });
    sameSiteSelect.setAttribute('aria-label', 'SameSite');
    const secureInput = document.createElement('input');
    secureInput.type  = 'checkbox';
    secureInput.title = 'Secure';
    secureInput.setAttribute('aria-label', 'Secure');
    const httpOnlyInput = document.createElement('input');
    httpOnlyInput.type  = 'checkbox';
    httpOnlyInput.title = 'HttpOnly';
    httpOnlyInput.setAttribute('aria-label', 'HttpOnly');

    // Cell order matches the table: Name · Value · Domain · Path · Expires · Flags · ×
    const flagsCell = document.createElement('div');
    flagsCell.className = 'storage-add-flags';
    flagsCell.append(sameSiteSelect, secureInput, httpOnlyInput);
    const cells = [nameInput, valInput, domainInput, pathInput, expiryInput, flagsCell];
    for (const el of cells) {
      const td = document.createElement('td');
      td.appendChild(el);
      addTr.appendChild(td);
    }
    const cancelTd = document.createElement('td');
    const cancelBtn = document.createElement('button');
    cancelBtn.className   = 'storage-delete-btn';
    cancelBtn.textContent = '×';
    cancelBtn.title       = 'Cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel');
    cancelTd.appendChild(cancelBtn);
    addTr.appendChild(cancelTd);
    cookieTbody.prepend(addTr);
    nameInput.focus();

    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      const name = nameInput.value.trim();
      if (!name) { renderStoragePanel(); return; }
      const domain = domainInput.value.trim() || currentHostname || 'localhost';
      const path    = pathInput.value.trim() || '/';
      const secure  = secureInput.checked;
      const httpOnly = httpOnlyInput.checked;
      const sameSite = sameSiteSelect.value || undefined;
      const expirationDate = expiryInput.value
        ? Math.floor(new Date(expiryInput.value).getTime() / 1000)
        : undefined;
      const url = `${secure ? 'https' : 'http'}://${domain.replace(/^\./, '')}${path}`;
      try {
        await testerBrowser.sessions.setCookie(sessionId, {
          url, name, value: valInput.value, domain, path, secure, httpOnly, sameSite, expirationDate,
        });
      } catch (err) {
        done = false;
        showRowError(addTr, cells.length + 1, `Failed to add cookie: ${err?.message || err}`);
        return;
      }
      fetchStorageData();
    };
    const cancel = () => { if (done) return; done = true; renderStoragePanel(); };
    cancelBtn.onclick = cancel;
    [nameInput, valInput, domainInput, pathInput, expiryInput].forEach(inp => {
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') cancel();
      });
    });
    addTr.addEventListener('focusout', () => setTimeout(() => {
      if (!addTr.contains(document.activeElement)) commit();
    }, 100));
  };

  const clear = cookies.length > 0 ? async () => {
    await testerBrowser.sessions.clearCookies(sessionId);
    fetchStorageData();
  } : null;

  if (filteredCookies.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'storage-empty';
    empty.setAttribute('data-cookie-empty', '1');
    empty.textContent = filterText ? 'No cookies match the filter' : 'No cookies for this session';
    panel.appendChild(empty);
  }
  for (const c of filteredCookies) {
    const isFirstParty  = cookieMatchesDomain(c, currentHostname);
    const isRelevant3P  = !isFirstParty && loadedDomains.some(d => cookieMatchesDomain(c, d));
    const isUnrelated3P = !isFirstParty && !isRelevant3P;

    const tr = document.createElement('tr');
    // Third-party rows read quieter (60%); one set during a different
    // navigation, which the page never loaded, quieter still.
    if (isUnrelated3P && currentHostname) tr.classList.add('cookie-row-irrelevant');
    else if (isRelevant3P && domainFilterActive) tr.classList.add('cookie-row-3p');

    const nameTd = document.createElement('td');
    nameTd.className = 'storage-key';
    nameTd.textContent = c.name;
    nameTd.title = c.name;
    tr.appendChild(nameTd);

    const valTd = document.createElement('td');
    valTd.className  = 'copyable storage-val';
    valTd.textContent = c.value;
    valTd.title       = `${c.value}\n\nClick to copy · Double-click to edit`;
    valTd.onclick     = () => { copyToClipboard(c.value); flashCopied(valTd); };
    valTd.ondblclick  = (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'ls-edit-input';
      input.value = c.value;
      valTd.innerHTML  = '';
      valTd.style.overflow = 'visible';
      valTd.appendChild(input);
      input.focus(); input.select();
      let done = false;
      const commit = async () => {
        if (done) return; done = true;
        if (input.value === c.value) { revertValueCell(valTd, c.value); return; }
        // Only the value changes here — name/domain/path stay the same, so
        // this is a same-identity update: a single setCookie() overwrites
        // in place. setCookie() is tried first; the old cookie is never
        // deleted, so a rejected set (bad domain/path/Secure combination)
        // leaves the original untouched instead of destroying it.
        const host = (c.domain || '').replace(/^\./, '') || currentHostname || 'localhost';
        const url  = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
        try {
          await testerBrowser.sessions.setCookie(sessionId, {
            url, name: c.name, value: input.value,
            domain: c.domain, path: c.path,
            secure: c.secure, httpOnly: c.httpOnly,
            expirationDate: c.expirationDate, sameSite: c.sameSite,
          });
        } catch (err) {
          revertValueCell(valTd, c.value);
          showRowError(tr, 7, `Failed to save cookie: ${err?.message || err}`);
          return;
        }
        fetchStorageData();
      };
      const cancel = () => { if (done) return; done = true; revertValueCell(valTd, c.value); };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') cancel();
      });
      input.addEventListener('blur', commit);
    };
    tr.appendChild(valTd);

    const domainTd = document.createElement('td');
    domainTd.className = 'storage-domain';
    domainTd.appendChild(document.createTextNode(c.domain || ''));
    domainTd.title = c.domain || '';
    if (currentHostname) {
      const tag = document.createElement('span');
      if (isFirstParty) {
        tag.className = 'cookie-3p first';
        tag.textContent = '1st';
        tag.title = 'Set by this page\'s own domain';
      } else {
        tag.className = isRelevant3P ? 'cookie-3p relevant' : 'cookie-3p other';
        tag.textContent = '3rd';
        tag.title = isRelevant3P ? 'Set by a resource loaded on this page' : 'Set during a different navigation';
      }
      domainTd.appendChild(tag);
    }
    tr.appendChild(domainTd);

    const pathTd = document.createElement('td'); pathTd.className = 'storage-path'; pathTd.textContent = c.path || '/'; pathTd.title = c.path || '/'; tr.appendChild(pathTd);
    const expTd  = document.createElement('td');
    expTd.className = 'storage-expires';
    expTd.textContent = c.expirationDate ? formatRelativeExpiry(c.expirationDate * 1000) : '—';
    expTd.title = c.expirationDate ? formatCookieExpiry(c.expirationDate) : 'Session cookie';
    tr.appendChild(expTd);

    // Flags as outline tags: HttpOnly, Secure, then Lax / Strict / None.
    const flagsTd = document.createElement('td');
    flagsTd.className = 'storage-flags';
    const flags = [];
    if (c.httpOnly) flags.push('HttpOnly');
    if (c.secure) flags.push('Secure');
    const ssLabel = formatSameSite(c.sameSite);
    if (ssLabel !== '—') flags.push(ssLabel);
    // The Flags column hides in narrow panels (style.css), so the name cell carries them too.
    if (flags.length) nameTd.title = `${c.name}\n${flags.join(', ')}`;
    for (const f of flags) {
      const tag = document.createElement('span');
      tag.className = 'storage-tag';
      tag.textContent = f;
      flagsTd.appendChild(tag);
    }
    tr.appendChild(flagsTd);

    const delTd  = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className   = 'storage-delete-btn';
    delBtn.textContent = '×';
    delBtn.title       = 'Delete this cookie';
    delBtn.setAttribute('aria-label', 'Delete this cookie');
    delBtn.onclick = async () => {
      await testerBrowser.sessions.deleteCookie(sessionId, c.name, c.domain || '', c.path || '/', !!c.secure);
      fetchStorageData();
    };
    delTd.appendChild(delBtn);
    tr.appendChild(delTd);
    cookieTbody.appendChild(tr);
  }
  cookieTable.appendChild(cookieTbody);
  panel.appendChild(cookieTable);
  return { add, clear };
}

// ── Local Storage ──

function renderLocalStorageSection(panel, sessionId, ls, filterText) {
  const lsEntries   = Object.entries(ls);
  const filteredLs  = filterText
    ? lsEntries.filter(([k, v]) =>
        k.toLowerCase().includes(filterText) || v.toLowerCase().includes(filterText))
    : lsEntries;

  const clear = lsEntries.length > 0 ? async () => {
    await testerBrowser.sessions.clearLocalStorage(sessionId);
    fetchStorageData();
  } : null;

  const lsTable  = document.createElement('table');
  lsTable.className = 'storage-table';
  lsTable.className = 'storage-table storage-kv-table';
  lsTable.innerHTML = '<colgroup><col style="width:260px"><col><col style="width:60px"><col style="width:36px"></colgroup><thead><tr><th>Key</th><th>Value</th><th>Size</th><th></th></tr></thead>';
  const lsTbody = document.createElement('tbody');

  const add = () => {
    if (lsTable.querySelector('.storage-add-row')) return;
    const addTr    = document.createElement('tr');
    addTr.className = 'storage-add-row';
    const keyInput = document.createElement('input');
    keyInput.className   = 'ls-edit-input';
    keyInput.placeholder = 'key';
    const valInput = document.createElement('input');
    valInput.className   = 'ls-edit-input';
    valInput.placeholder = 'value';
    const keyTd = document.createElement('td'); keyTd.appendChild(keyInput); addTr.appendChild(keyTd);
    const valTd2 = document.createElement('td'); valTd2.appendChild(valInput); addTr.appendChild(valTd2);
    addTr.appendChild(document.createElement('td'));
    const cancelTd = document.createElement('td');
    const cancelBtn = document.createElement('button');
    cancelBtn.className   = 'storage-delete-btn';
    cancelBtn.textContent = '×';
    cancelBtn.title       = 'Cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel');
    cancelTd.appendChild(cancelBtn);
    addTr.appendChild(cancelTd);
    lsTbody.prepend(addTr);
    keyInput.focus();

    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      const key = keyInput.value.trim();
      if (key) await testerBrowser.sessions.setLocalStorageKey(sessionId, key, valInput.value).catch(() => {});
      fetchStorageData();
    };
    const cancel = () => { if (done) return; done = true; renderStoragePanel(); };
    cancelBtn.onclick = cancel;
    [keyInput, valInput].forEach(inp => inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') cancel();
    }));
    valInput.addEventListener('blur', () => setTimeout(() => {
      if (!addTr.contains(document.activeElement)) commit();
    }, 100));
  };

  if (filteredLs.length === 0) {
    const empty = document.createElement('div');
    empty.className   = 'storage-empty';
    empty.textContent = filterText ? 'No entries match the filter' : 'No local storage entries for this page';
    panel.appendChild(empty);
  }
  for (const [k, v] of filteredLs) {
    const tr = document.createElement('tr');

    const keyTd = document.createElement('td');
    keyTd.className   = 'storage-key';
    keyTd.textContent = k;
    keyTd.title       = 'Double-click to rename key';
    keyTd.ondblclick  = (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'ls-edit-input';
      input.value     = k;
      keyTd.innerHTML = '';
      keyTd.appendChild(input);
      input.focus(); input.select();
      let done = false;
      const commit = async () => {
        if (done) return; done = true;
        const newKey = input.value.trim();
        if (newKey && newKey !== k) {
          await testerBrowser.sessions.setLocalStorageKey(sessionId, newKey, v).catch(() => {});
          await testerBrowser.sessions.deleteLocalStorageKey(sessionId, k).catch(() => {});
        }
        fetchStorageData();
      };
      const cancel = () => { if (done) return; done = true; renderStoragePanel(); };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') cancel();
      });
      input.addEventListener('blur', commit);
    };
    tr.appendChild(keyTd);

    const valTd = document.createElement('td');
    valTd.className  = 'copyable storage-val';
    valTd.textContent = v;
    valTd.title       = 'Click to copy · Double-click to edit';
    valTd.onclick     = () => { copyToClipboard(v); flashCopied(valTd); };
    valTd.ondblclick  = (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'ls-edit-input';
      input.value     = v;
      valTd.innerHTML = '';
      valTd.appendChild(input);
      input.focus(); input.select();
      let done = false;
      const commit = async () => {
        if (done) return; done = true;
        await testerBrowser.sessions.setLocalStorageKey(sessionId, k, input.value);
        fetchStorageData();
      };
      const cancel = () => { if (done) return; done = true; renderStoragePanel(); };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') cancel();
      });
      input.addEventListener('blur', commit);
    };
    tr.appendChild(valTd);

    const sizeTd = document.createElement('td');
    sizeTd.className = 'storage-size';
    sizeTd.textContent = String(new Blob([k, v]).size);
    tr.appendChild(sizeTd);

    const delTd  = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className   = 'storage-delete-btn';
    delBtn.textContent = '×';
    delBtn.title       = 'Delete this entry';
    delBtn.setAttribute('aria-label', 'Delete this entry');
    delBtn.onclick = async () => {
      await testerBrowser.sessions.deleteLocalStorageKey(sessionId, k);
      fetchStorageData();
    };
    delTd.appendChild(delBtn);
    tr.appendChild(delTd);
    lsTbody.appendChild(tr);
  }
  lsTable.appendChild(lsTbody);
  panel.appendChild(lsTable);
  return { add, clear };
}

// ── Session Storage (read-only) ──

function renderSessionStorageSection(panel, ss, filterText) {
  const ssEntries  = Object.entries(ss);
  const filteredSs = filterText
    ? ssEntries.filter(([k, v]) =>
        k.toLowerCase().includes(filterText) || v.toLowerCase().includes(filterText))
    : ssEntries;

  if (filteredSs.length === 0) {
    const empty = document.createElement('div');
    empty.className   = 'storage-empty';
    empty.textContent = filterText ? 'No entries match the filter' : 'No sessionStorage entries for this page';
    panel.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'storage-table storage-kv-table';
  table.innerHTML = '<colgroup><col style="width:260px"><col><col style="width:60px"></colgroup><thead><tr><th>Key</th><th>Value</th><th>Size</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const [k, v] of filteredSs) {
    const tr = document.createElement('tr');
    const keyTd = document.createElement('td'); keyTd.className = 'storage-key'; keyTd.textContent = k; tr.appendChild(keyTd);
    const valTd = document.createElement('td');
    valTd.className  = 'copyable storage-val';
    valTd.textContent = v;
    valTd.title       = 'Click to copy';
    valTd.onclick     = () => { copyToClipboard(v); flashCopied(valTd); };
    tr.appendChild(valTd);
    const sizeTd = document.createElement('td');
    sizeTd.className = 'storage-size';
    sizeTd.textContent = String(new Blob([k, v]).size);
    tr.appendChild(sizeTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  panel.appendChild(table);
}

// ── IndexedDB (read-only, database → object store → records) ──

function renderIndexedDBSection(panel, idb, filterText) {
  const dbNames = Object.keys(idb || {});

  if (dbNames.length === 0) {
    const empty = document.createElement('div');
    empty.className   = 'storage-empty';
    empty.textContent = 'No IndexedDB databases for this page';
    panel.appendChild(empty);
    return;
  }

  let anyVisible = false;
  for (const dbName of dbNames) {
    const dbSnap = idb[dbName];
    const storeNames = Object.keys(dbSnap.stores || {});
    const visibleStores = storeNames.filter((storeName) => {
      if (!filterText) return true;
      if (dbName.toLowerCase().includes(filterText) || storeName.toLowerCase().includes(filterText)) return true;
      const records = dbSnap.stores[storeName].records || [];
      return records.some(r =>
        JSON.stringify(r.key).toLowerCase().includes(filterText) ||
        JSON.stringify(r.value).toLowerCase().includes(filterText));
    });
    if (filterText && visibleStores.length === 0) continue;
    anyVisible = true;

    const dbDetails = document.createElement('details');
    dbDetails.className = 'storage-idb-db';
    dbDetails.open = !!filterText;
    const dbSummary = document.createElement('summary');
    dbSummary.textContent = `${dbName} (v${dbSnap.version}, ${storeNames.length} store${storeNames.length === 1 ? '' : 's'})`;
    dbDetails.appendChild(dbSummary);

    for (const storeName of visibleStores) {
      const store = dbSnap.stores[storeName];
      const records = store.records || [];
      const storeDetails = document.createElement('details');
      storeDetails.className = 'storage-idb-store';
      storeDetails.open = !!filterText;
      const storeSummary = document.createElement('summary');
      storeSummary.textContent = `${storeName} (${records.length} row${records.length === 1 ? '' : 's'})`;
      storeDetails.appendChild(storeSummary);

      const table = document.createElement('table');
      table.className = 'storage-table storage-kv-table';
      table.innerHTML = '<colgroup><col style="width:260px"><col></colgroup><thead><tr><th>Key</th><th>Value</th></tr></thead>';
      const tbody = document.createElement('tbody');
      for (const r of records) {
        const tr = document.createElement('tr');
        const keyTd = document.createElement('td'); keyTd.textContent = JSON.stringify(r.key); tr.appendChild(keyTd);
        const valStr = JSON.stringify(r.value);
        const valTd = document.createElement('td');
        valTd.className  = 'copyable storage-val';
        valTd.textContent = valStr;
        valTd.title       = 'Click to copy';
        valTd.onclick     = () => { copyToClipboard(valStr); flashCopied(valTd); };
        tr.appendChild(valTd);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      storeDetails.appendChild(table);
      dbDetails.appendChild(storeDetails);
    }
    panel.appendChild(dbDetails);
  }

  const note = document.createElement('div');
  note.className = 'storage-hint';
  note.textContent = 'IndexedDB is read-only.';
  panel.appendChild(note);

  if (filterText && !anyVisible) {
    const empty = document.createElement('div');
    empty.className   = 'storage-empty';
    empty.textContent = 'No IndexedDB entries match the filter';
    panel.appendChild(empty);
  }
}

// ── Permissions (#276) — grants/denials remembered for this session's
// partition, revocable here. A revoked entry just goes back to "will
// prompt again next time"; it isn't shown as anything else in this list. ──

function formatPermissionOrigin(origin) {
  return origin.startsWith('malformed:') ? `(unparseable URL) ${origin.slice('malformed:'.length)}` : origin;
}

function renderPermissionsSection(panel, sessionId, permissions, filterText) {
  const filtered = filterText
    ? permissions.filter(p =>
        p.origin.toLowerCase().includes(filterText) || p.permission.toLowerCase().includes(filterText))
    : permissions;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'storage-empty';
    empty.textContent = filterText ? 'No permissions match the filter' : 'No permission grants or denials remembered for this session';
    panel.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'storage-table';
  table.innerHTML = '<thead><tr><th>Origin</th><th>Permission</th><th>Status</th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const p of filtered) {
    const tr = document.createElement('tr');

    const originTd = document.createElement('td');
    originTd.textContent = formatPermissionOrigin(p.origin);
    tr.appendChild(originTd);

    const permTd = document.createElement('td');
    permTd.textContent = p.permission;
    tr.appendChild(permTd);

    const statusTd = document.createElement('td');
    statusTd.innerHTML = `<span class="storage-badge ${p.status === 'granted' ? 'yes' : 'no'}">${p.status === 'granted' ? 'Granted' : 'Denied'}</span>`;
    tr.appendChild(statusTd);

    const revokeTd = document.createElement('td');
    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'storage-delete-btn';
    revokeBtn.textContent = '×';
    revokeBtn.title = 'Revoke — the page will be prompted again next time';
    revokeBtn.setAttribute('aria-label', 'Revoke');
    revokeBtn.onclick = async () => {
      await testerBrowser.permission.revoke(sessionId, p.origin, p.permission);
      fetchStorageData();
    };
    revokeTd.appendChild(revokeBtn);
    tr.appendChild(revokeTd);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  panel.appendChild(table);
}

// ── Auto-refresh: polls every 2s, but only while the Storage tab is active
// and the console panel is visible — mirrors debuglog.js's tab-switch
// stop/resume pattern (see console-tabs.js's switchConsoleTab). ──

function tickAutoRefresh() {
  if (getActiveConsoleTab() !== 'storage' || !isConsoleVisible()) return;
  fetchStorageData();
}

function startAutoRefreshTimer() {
  if (autoRefreshTimer) return;
  autoRefreshTimer = setInterval(tickAutoRefresh, 2000);
}

export function stopStorageAutoRefreshPolling() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
}

export function resumeStorageAutoRefreshIfOn() {
  if (autoRefreshOn) startAutoRefreshTimer();
}

export function initStorage() {
  // #304: section nav + the toolbar's Add / Clear all act on the active section.
  for (const item of document.querySelectorAll('#storageNav [data-section]')) {
    item.addEventListener('click', () => {
      activeSection = /** @type {HTMLElement} */ (item).dataset.section;
      renderStoragePanel();
    });
  }
  document.getElementById('storageAddBtn').addEventListener('click', () => sectionActions.add?.());
  document.getElementById('storageClearBtn').addEventListener('click', () => sectionActions.clear?.());

  document.getElementById('refreshStorageBtn').addEventListener('click', fetchStorageData);
  /** @type {HTMLInputElement} */ (document.getElementById('storageFilter')).addEventListener('input', renderStoragePanel);

  const domainFilterBtn = document.getElementById('domainFilterBtn');
  domainFilterBtn.classList.add('active'); // matches domainFilterActive = true default
  domainFilterBtn.addEventListener('click', () => {
    domainFilterActive = !domainFilterActive;
    domainFilterBtn.classList.toggle('active', domainFilterActive);
    renderStoragePanel();
  });

  const autoRefreshBtn = document.getElementById('storageAutoRefreshBtn');
  autoRefreshBtn.addEventListener('click', () => {
    autoRefreshOn = !autoRefreshOn;
    autoRefreshBtn.classList.toggle('active', autoRefreshOn);
    if (autoRefreshOn) startAutoRefreshTimer();
    else stopStorageAutoRefreshPolling();
  });
}
