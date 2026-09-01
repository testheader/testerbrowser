/* global testerBrowser */
import { state } from './state.js';
import { cookieMatchesDomain } from './utils.js';

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

export async function loadStoragePanel() {
  if (!state.activeId) return;
  const panel = document.getElementById('storagePanel');
  panel.innerHTML = '<div class="storage-empty">Loading…</div>';

  const filterText = document.getElementById('storageFilter').value.toLowerCase();
  const sessionId  = state.activeId;

  const urlbarVal = document.getElementById('urlbar').value;
  let currentHostname = '';
  try {
    if (urlbarVal && urlbarVal.startsWith('http')) currentHostname = new URL(urlbarVal).hostname;
  } catch {}

  const [cookies, ls, loadedDomains] = await Promise.all([
    testerBrowser.sessions.getCookies(sessionId),
    testerBrowser.sessions.getLocalStorage(sessionId),
    testerBrowser.sessions.getLoadedDomains(sessionId),
  ]);

  panel.innerHTML = '';

  // ── Cookies ──
  const textFiltered = filterText
    ? cookies.filter(c =>
        (c.domain || '').toLowerCase().includes(filterText) ||
        c.name.toLowerCase().includes(filterText) ||
        c.value.toLowerCase().includes(filterText))
    : cookies;

  const filteredCookies = state.domainFilterActive
    ? textFiltered.filter(c =>
        cookieMatchesDomain(c, currentHostname) ||
        loadedDomains.some(d => cookieMatchesDomain(c, d)))
    : textFiltered;

  const cookieHdr = document.createElement('div');
  cookieHdr.className = 'storage-section-header';
  const cookieTitle = document.createElement('span');
  cookieTitle.className = 'storage-section-title';
  cookieTitle.textContent = `Cookies (${filteredCookies.length}${filterText && filteredCookies.length !== cookies.length ? '/' + cookies.length : ''})`;
  cookieHdr.appendChild(cookieTitle);
  const cookieAddBtn = document.createElement('button');
  cookieAddBtn.className   = 'storage-add-btn';
  cookieAddBtn.textContent = '+ Add';
  cookieAddBtn.title       = 'Add a new cookie';
  cookieHdr.appendChild(cookieAddBtn);
  if (cookies.length > 0) {
    const clearBtn = document.createElement('button');
    clearBtn.className   = 'storage-clear-btn';
    clearBtn.textContent = 'Clear All';
    clearBtn.title       = 'Delete all cookies for this session';
    clearBtn.onclick = async () => {
      await testerBrowser.sessions.clearCookies(sessionId);
      loadStoragePanel();
    };
    cookieHdr.appendChild(clearBtn);
  }
  panel.appendChild(cookieHdr);

  const cookieTable = document.createElement('table');
  cookieTable.className = 'storage-table';
  cookieTable.innerHTML = '<thead><tr><th>Domain</th><th>Name</th><th>Value</th><th>Path</th><th>SameSite</th><th>Expires</th><th>Secure</th><th>HttpOnly</th><th></th></tr></thead>';
  const cookieTbody = document.createElement('tbody');

  cookieAddBtn.onclick = () => {
    if (cookieTable.querySelector('.storage-add-row')) return;
    const addTr = document.createElement('tr');
    addTr.className = 'storage-add-row';
    const domainInput = document.createElement('input');
    domainInput.className   = 'ls-edit-input';
    domainInput.placeholder = 'domain';
    domainInput.value       = currentHostname || '';
    const nameInput = document.createElement('input');
    nameInput.className   = 'ls-edit-input';
    nameInput.placeholder = 'name';
    const valInput = document.createElement('input');
    valInput.className   = 'ls-edit-input';
    valInput.placeholder = 'value';
    const pathInput = document.createElement('input');
    pathInput.className   = 'ls-edit-input';
    pathInput.placeholder = 'path';
    pathInput.value       = '/';
    ['domain','name','value','path','','','','',''].forEach((field) => {
      const td = document.createElement('td');
      if (field === 'domain') td.appendChild(domainInput);
      else if (field === 'name')  td.appendChild(nameInput);
      else if (field === 'value') td.appendChild(valInput);
      else if (field === 'path')  td.appendChild(pathInput);
      addTr.appendChild(td);
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.className   = 'storage-delete-btn';
    cancelBtn.textContent = '×';
    cancelBtn.title       = 'Cancel';
    addTr.lastElementChild.appendChild(cancelBtn);
    cookieTbody.prepend(addTr);
    nameInput.focus();

    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      const name = nameInput.value.trim();
      if (!name) { loadStoragePanel(); return; }
      const domain = domainInput.value.trim() || currentHostname || 'localhost';
      const path   = pathInput.value.trim() || '/';
      const url    = `http://${domain.replace(/^\./, '')}${path}`;
      await testerBrowser.sessions.setCookie(sessionId, { url, name, value: valInput.value, domain, path }).catch(() => {});
      loadStoragePanel();
    };
    const cancel = () => { if (done) return; done = true; loadStoragePanel(); };
    cancelBtn.onclick = cancel;
    [domainInput, nameInput, valInput, pathInput].forEach(inp => {
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') cancel();
      });
    });
    valInput.addEventListener('blur', () => setTimeout(() => {
      if (!addTr.contains(document.activeElement)) commit();
    }, 100));
  };

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
    if (isUnrelated3P && currentHostname) tr.classList.add('cookie-row-irrelevant');

    const domainTd = document.createElement('td');
    domainTd.textContent = c.domain || '';
    if (isRelevant3P && currentHostname) {
      const badge = document.createElement('span');
      badge.className   = 'cookie-3p relevant';
      badge.textContent = '3P';
      badge.title       = 'Set by a resource loaded on this page';
      domainTd.appendChild(badge);
    } else if (isUnrelated3P && currentHostname) {
      const badge = document.createElement('span');
      badge.className   = 'cookie-3p other';
      badge.textContent = '3P';
      badge.title       = 'Set during a different navigation';
      domainTd.appendChild(badge);
    }
    tr.appendChild(domainTd);

    const nameTd = document.createElement('td');
    nameTd.textContent = c.name;
    tr.appendChild(nameTd);

    const valTd = document.createElement('td');
    valTd.className  = 'copyable';
    valTd.style.cssText = 'max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    valTd.textContent = c.value;
    valTd.title       = 'Click to copy · Double-click to edit';
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
        if (input.value !== c.value) {
          const host = (c.domain || '').replace(/^\./, '') || currentHostname || 'localhost';
          const url  = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
          await testerBrowser.sessions.deleteCookie(sessionId, c.name, c.domain || '', c.path || '/', !!c.secure);
          await testerBrowser.sessions.setCookie(sessionId, {
            url, name: c.name, value: input.value,
            domain: c.domain, path: c.path,
            secure: c.secure, httpOnly: c.httpOnly,
            expirationDate: c.expirationDate, sameSite: c.sameSite,
          }).catch(() => {});
        }
        loadStoragePanel();
      };
      const cancel = () => { if (done) return; done = true; loadStoragePanel(); };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') cancel();
      });
      input.addEventListener('blur', commit);
    };
    tr.appendChild(valTd);

    const pathTd = document.createElement('td'); pathTd.textContent = c.path || '/'; tr.appendChild(pathTd);
    const ssTd   = document.createElement('td'); ssTd.textContent   = formatSameSite(c.sameSite); tr.appendChild(ssTd);
    const expTd  = document.createElement('td');
    expTd.style.whiteSpace = 'nowrap';
    expTd.textContent = formatCookieExpiry(c.expirationDate);
    tr.appendChild(expTd);
    const secureTd   = document.createElement('td');
    secureTd.innerHTML  = `<span class="storage-badge ${c.secure   ? 'yes' : 'no'}">${c.secure   ? '✓' : '—'}</span>`;
    tr.appendChild(secureTd);
    const httpOnlyTd  = document.createElement('td');
    httpOnlyTd.innerHTML = `<span class="storage-badge ${c.httpOnly ? 'yes' : 'no'}">${c.httpOnly ? '✓' : '—'}</span>`;
    tr.appendChild(httpOnlyTd);

    const delTd  = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className   = 'storage-delete-btn';
    delBtn.textContent = '×';
    delBtn.title       = 'Delete this cookie';
    delBtn.onclick = async () => {
      await testerBrowser.sessions.deleteCookie(sessionId, c.name, c.domain || '', c.path || '/', !!c.secure);
      loadStoragePanel();
    };
    delTd.appendChild(delBtn);
    tr.appendChild(delTd);
    cookieTbody.appendChild(tr);
  }
  cookieTable.appendChild(cookieTbody);
  panel.appendChild(cookieTable);

  // ── Local Storage ──
  const lsEntries   = Object.entries(ls);
  const filteredLs  = filterText
    ? lsEntries.filter(([k, v]) =>
        k.toLowerCase().includes(filterText) || v.toLowerCase().includes(filterText))
    : lsEntries;

  const lsHdr = document.createElement('div');
  lsHdr.className = 'storage-section-header';
  const lsTitle = document.createElement('span');
  lsTitle.className   = 'storage-section-title';
  lsTitle.textContent = `Local Storage (${filteredLs.length}${filterText && filteredLs.length !== lsEntries.length ? '/' + lsEntries.length : ''})`;
  lsHdr.appendChild(lsTitle);
  const lsAddBtn = document.createElement('button');
  lsAddBtn.className   = 'storage-add-btn';
  lsAddBtn.textContent = '+ Add';
  lsAddBtn.title       = 'Add a new localStorage entry';
  lsHdr.appendChild(lsAddBtn);
  if (lsEntries.length > 0) {
    const clearBtn = document.createElement('button');
    clearBtn.className   = 'storage-clear-btn';
    clearBtn.textContent = 'Clear All';
    clearBtn.title       = 'Clear all localStorage for this page';
    clearBtn.onclick = async () => {
      await testerBrowser.sessions.clearLocalStorage(sessionId);
      loadStoragePanel();
    };
    lsHdr.appendChild(clearBtn);
  }
  panel.appendChild(lsHdr);

  const lsTable  = document.createElement('table');
  lsTable.className = 'storage-table';
  lsTable.innerHTML = '<thead><tr><th style="width:35%">Key</th><th>Value</th><th></th></tr></thead>';
  const lsTbody = document.createElement('tbody');

  lsAddBtn.onclick = () => {
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
    const cancelTd = document.createElement('td');
    const cancelBtn = document.createElement('button');
    cancelBtn.className   = 'storage-delete-btn';
    cancelBtn.textContent = '×';
    cancelBtn.title       = 'Cancel';
    cancelTd.appendChild(cancelBtn);
    addTr.appendChild(cancelTd);
    lsTbody.prepend(addTr);
    keyInput.focus();

    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      const key = keyInput.value.trim();
      if (key) await testerBrowser.sessions.setLocalStorageKey(sessionId, key, valInput.value).catch(() => {});
      loadStoragePanel();
    };
    const cancel = () => { if (done) return; done = true; loadStoragePanel(); };
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
        loadStoragePanel();
      };
      const cancel = () => { if (done) return; done = true; loadStoragePanel(); };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') cancel();
      });
      input.addEventListener('blur', commit);
    };
    tr.appendChild(keyTd);

    const valTd = document.createElement('td');
    valTd.className  = 'copyable';
    valTd.style.cssText = 'max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
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
        loadStoragePanel();
      };
      const cancel = () => { if (done) return; done = true; loadStoragePanel(); };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') cancel();
      });
      input.addEventListener('blur', commit);
    };
    tr.appendChild(valTd);

    const delTd  = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className   = 'storage-delete-btn';
    delBtn.textContent = '×';
    delBtn.title       = 'Delete this entry';
    delBtn.onclick = async () => {
      await testerBrowser.sessions.deleteLocalStorageKey(sessionId, k);
      loadStoragePanel();
    };
    delTd.appendChild(delBtn);
    tr.appendChild(delTd);
    lsTbody.appendChild(tr);
  }
  lsTable.appendChild(lsTbody);
  panel.appendChild(lsTable);
}

export function initStorage() {
  document.getElementById('refreshStorageBtn').addEventListener('click', loadStoragePanel);
  document.getElementById('storageFilter').addEventListener('input', loadStoragePanel);

  const domainFilterBtn = document.getElementById('domainFilterBtn');
  domainFilterBtn.classList.add('active'); // matches domainFilterActive = true default
  domainFilterBtn.addEventListener('click', () => {
    state.domainFilterActive = !state.domainFilterActive;
    domainFilterBtn.classList.toggle('active', state.domainFilterActive);
    loadStoragePanel();
  });
}
