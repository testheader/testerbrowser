/* global testerBrowser */

// ── State ──────────────────────────────────────────────────────────────────

let activeId      = null;
let lastTs        = 0;
let sessionCounter = 0;
let mruStack      = [];
let tabOrder      = [];
let tabClickTimer = null;
let dragSourceId  = null;

const tabFavicons = {};   // id → favicon url
const tabTitles   = {};   // id → page title (tooltip)
const navState    = {};   // id → { canBack, canForward }

const closedTabs  = [];   // [{ name, url, partition }] — most recent last

let notesSessionId = null;

// ── Console resize ─────────────────────────────────────────────────────────

const CONSOLE_DEFAULT = 220;
const TOPBAR_BASE     = 88;
const FIND_BAR_H      = 40;

let consoleHeight = CONSOLE_DEFAULT;

const consolePanel      = document.getElementById('consolePanel');
const consoleDragHandle = document.getElementById('consoleDragHandle');

function setConsoleHeight(h) {
  consoleHeight = Math.max(80, Math.min(h, window.innerHeight - 120));
  consolePanel.style.height = consoleHeight + 'px';
  testerBrowser.layout.setConsoleHeight(consoleHeight);
}

consoleDragHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startY = e.clientY, startH = consoleHeight;
  consoleDragHandle.classList.add('dragging');
  const onMove = (ev) => setConsoleHeight(startH + (startY - ev.clientY));
  const onUp   = () => {
    consoleDragHandle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
});

// ── Tab order helpers ──────────────────────────────────────────────────────

function insertAfterActive(id) {
  const idx = activeId ? tabOrder.indexOf(activeId) : -1;
  if (idx === -1) tabOrder.push(id);
  else tabOrder.splice(idx + 1, 0, id);
}

function recordVisit(id) {
  mruStack = [id, ...mruStack.filter((x) => x !== id)];
}

// ── Session switching ──────────────────────────────────────────────────────

async function switchToSession(id) {
  activeId = id;
  lastTs   = 0;
  document.getElementById('timelinePanel').innerHTML = '';
  recordVisit(id);
  await testerBrowser.sessions.switchTo(id);
  updateNavButtons();
  refreshTabs();
}

function cycleTab(reverse) {
  if (mruStack.length < 2) return;
  switchToSession(reverse ? mruStack[mruStack.length - 1] : mruStack[1]);
}

function updateNavButtons() {
  const ns = navState[activeId] || {};
  document.getElementById('backBtn').disabled  = !ns.canBack;
  document.getElementById('fwdBtn').disabled   = !ns.canForward;
}

// ── Tab rendering ──────────────────────────────────────────────────────────

async function refreshTabs() {
  const sessions  = await testerBrowser.sessions.list();
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));

  tabOrder = tabOrder.filter((id) => sessionMap.has(id));
  for (const s of sessions) if (!tabOrder.includes(s.id)) tabOrder.push(s.id);

  const tabsEl = document.getElementById('tabs');
  tabsEl.querySelectorAll('.tab').forEach((el) => el.remove());

  for (const id of tabOrder) {
    const s = sessionMap.get(id);

    const tab = document.createElement('span');
    tab.className = 'tab' + (s.id === activeId ? ' active' : '');
    tab.dataset.id = s.id;

    // favicon
    if (tabFavicons[s.id]) {
      const img = document.createElement('img');
      img.className = 'tab-favicon';
      img.src = tabFavicons[s.id];
      img.onerror = () => img.remove();
      tab.appendChild(img);
    } else {
      const dot = document.createElement('span');
      dot.className = 'tab-dot ' + (s.persistent ? 'persistent' : 'ephemeral');
      dot.title = s.persistent ? 'Persistent session' : 'In-memory session';
      tab.appendChild(dot);
    }

    if (s.pinned) {
      const pin = document.createElement('span');
      pin.className = 'tab-pin';
      pin.textContent = '📌';
      tab.appendChild(pin);
    }

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = s.name;
    name.title = tabTitles[s.id] || s.name;
    name.onclick = () => {
      clearTimeout(tabClickTimer);
      tabClickTimer = setTimeout(() => switchToSession(s.id), 250);
    };
    name.ondblclick = (e) => { e.stopPropagation(); clearTimeout(tabClickTimer); startRename(s.id, name); };
    tab.appendChild(name);

    if (!s.pinned) {
      const x = document.createElement('span');
      x.className = 'tab-close';
      x.textContent = '×';
      x.title = 'Close (Ctrl+W)';
      x.onclick = (e) => { e.stopPropagation(); closeTab(s.id); };
      tab.appendChild(x);
    }

    tab.oncontextmenu = (e) => { e.preventDefault(); testerBrowser.sessions.contextMenu(s.id); };

    // drag-to-reorder
    tab.draggable = true;
    tab.addEventListener('dragstart', (e) => {
      dragSourceId = s.id;
      tab.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    tab.addEventListener('dragend', () => {
      dragSourceId = null;
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('dragging', 'drag-left', 'drag-right'));
    });
    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragSourceId || dragSourceId === s.id) return;
      const mid = tab.getBoundingClientRect().left + tab.offsetWidth / 2;
      tab.classList.toggle('drag-left',  e.clientX <= mid);
      tab.classList.toggle('drag-right', e.clientX >  mid);
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drag-left', 'drag-right'));
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drag-left', 'drag-right');
      if (!dragSourceId || dragSourceId === s.id) return;
      const before = e.clientX <= tab.getBoundingClientRect().left + tab.offsetWidth / 2;
      tabOrder = tabOrder.filter((x) => x !== dragSourceId);
      const to = tabOrder.indexOf(s.id);
      tabOrder.splice(before ? to : to + 1, 0, dragSourceId);
      refreshTabs();
    });

    tabsEl.insertBefore(tab, document.getElementById('newSessionBtn'));
  }

  mruStack = mruStack.filter((id) => sessionMap.has(id));
  if (!activeId && sessions.length) { activeId = sessions[0].id; recordVisit(activeId); }
  updateNavButtons();
}

// ── Rename ─────────────────────────────────────────────────────────────────

function startRename(id, nameEl) {
  const original = nameEl.textContent;
  const input = document.createElement('input');
  input.className = 'tab-rename-input';
  input.value = original;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    await testerBrowser.sessions.rename(id, input.value.trim() || original);
    refreshTabs();
  };
  const cancel = () => { if (done) return; done = true; input.replaceWith(nameEl); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') cancel(); });
  input.addEventListener('blur', commit);
}

// ── Close / reopen tab ─────────────────────────────────────────────────────

async function closeTab(id) {
  const sessions = await testerBrowser.sessions.list();
  const s = sessions.find((x) => x.id === id);
  if (s) closedTabs.push({ name: s.name, url: s.url || 'https://example.com', partition: s.partition });
  if (closedTabs.length > 20) closedTabs.shift();

  await testerBrowser.sessions.destroy(id);
  tabOrder = tabOrder.filter((x) => x !== id);
  mruStack = mruStack.filter((x) => x !== id);
  delete tabFavicons[id];
  delete tabTitles[id];
  delete navState[id];

  if (activeId === id) {
    activeId = null;
    const next = mruStack[0] ?? null;
    if (next) { await switchToSession(next); return; }
  }
  refreshTabs();
}

async function reopenTab() {
  const entry = closedTabs.pop();
  if (!entry) return;
  const id = await testerBrowser.sessions.reopen(entry);
  if (!id) return;
  insertAfterActive(id);
  await switchToSession(id);
}

// ── New tab button ─────────────────────────────────────────────────────────

document.getElementById('newSessionBtn').onclick = async () => {
  sessionCounter++;
  const id = await testerBrowser.sessions.create(`Session ${sessionCounter}`, { persistent: false });
  insertAfterActive(id);
  await switchToSession(id);
};

// ── Nav buttons ────────────────────────────────────────────────────────────

document.getElementById('backBtn').onclick   = () => activeId && testerBrowser.sessions.back(activeId);
document.getElementById('fwdBtn').onclick    = () => activeId && testerBrowser.sessions.forward(activeId);
document.getElementById('reloadBtn').onclick = () => activeId && testerBrowser.sessions.reload(activeId);
document.getElementById('devtoolsBtn').onclick = () => activeId && testerBrowser.sessions.devtools(activeId);

// ── URL bar ────────────────────────────────────────────────────────────────

document.getElementById('urlbar').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && activeId) {
    await testerBrowser.sessions.navigate(activeId, e.target.value);
    e.target.blur();
  }
  if (e.key === 'Escape') e.target.blur();
});

// ── Find bar ───────────────────────────────────────────────────────────────

const findBar   = document.getElementById('findBar');
const findInput = document.getElementById('findInput');
let findOpen    = false;
let findText    = '';

function openFind() {
  if (!findOpen) {
    findOpen = true;
    findBar.classList.add('open');
    testerBrowser.layout.setTopBarHeight(TOPBAR_BASE + FIND_BAR_H);
  }
  findInput.focus(); findInput.select();
}

function closeFind() {
  if (!findOpen) return;
  findOpen = false;
  findBar.classList.remove('open');
  findInput.classList.remove('no-match');
  document.getElementById('findCount').textContent = '';
  testerBrowser.layout.setTopBarHeight(TOPBAR_BASE);
  if (activeId) testerBrowser.sessions.stopFind(activeId);
}

function doFind(forward, next) {
  if (!activeId || !findText) return;
  testerBrowser.sessions.findInPage(activeId, findText, forward, next);
}

findInput.addEventListener('input', () => {
  findText = findInput.value;
  if (findText) doFind(true, false);
  else { document.getElementById('findCount').textContent = ''; if (activeId) testerBrowser.sessions.stopFind(activeId); }
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  { e.preventDefault(); doFind(!e.shiftKey, true); }
  if (e.key === 'Escape') closeFind();
});
document.getElementById('findPrevBtn').onclick  = () => doFind(false, true);
document.getElementById('findNextBtn').onclick  = () => doFind(true, true);
document.getElementById('findCloseBtn').onclick = () => closeFind();

testerBrowser.sessions.onFindResult(({ id, matches, activeMatch }) => {
  if (id !== activeId) return;
  const count = document.getElementById('findCount');
  if (matches === 0) { count.textContent = 'No results'; findInput.classList.add('no-match'); }
  else { count.textContent = `${activeMatch}/${matches}`; findInput.classList.remove('no-match'); }
});

// ── Keyboard shortcuts (renderer has focus) ────────────────────────────────

function handleShortcut(key) {
  switch (key) {
    case 'newTab':     document.getElementById('newSessionBtn').onclick(); break;
    case 'closeTab':   if (activeId) closeTab(activeId); break;
    case 'reopenTab':  reopenTab(); break;
    case 'focusUrl':   document.getElementById('urlbar').focus(); document.getElementById('urlbar').select(); break;
    case 'reload':     if (activeId) testerBrowser.sessions.reload(activeId); break;
    case 'findToggle': findOpen ? closeFind() : openFind(); break;
    case 'findNext':   doFind(true, true); break;
    case 'findPrev':   doFind(false, true); break;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Tab')         { e.preventDefault(); cycleTab(e.shiftKey); return; }
  if (e.ctrlKey && !e.shiftKey && e.key === 't') { e.preventDefault(); handleShortcut('newTab');    return; }
  if (e.ctrlKey && !e.shiftKey && e.key === 'w') { e.preventDefault(); handleShortcut('closeTab');  return; }
  if (e.ctrlKey && e.shiftKey  && e.key === 'T') { e.preventDefault(); handleShortcut('reopenTab'); return; }
  if (e.ctrlKey && e.key === 'l')           { e.preventDefault(); handleShortcut('focusUrl');   return; }
  if (e.ctrlKey && e.key === 'f')           { e.preventDefault(); handleShortcut('findToggle'); return; }
  if (e.key === 'F3')                       { e.preventDefault(); handleShortcut(e.shiftKey ? 'findPrev' : 'findNext'); return; }
  if ((e.ctrlKey && e.key === 'r') || e.key === 'F5') { e.preventDefault(); handleShortcut('reload'); return; }
  if (e.key === 'F12')                      { e.preventDefault(); if (activeId) testerBrowser.sessions.devtools(activeId); return; }
  if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); if (activeId) testerBrowser.sessions.setZoom(activeId, 0.1); return; }
  if (e.ctrlKey && e.key === '-')           { e.preventDefault(); if (activeId) testerBrowser.sessions.setZoom(activeId, -0.1); return; }
  if (e.ctrlKey && e.key === '0')           { e.preventDefault(); if (activeId) testerBrowser.sessions.resetZoom(activeId); return; }
  if (e.altKey && e.key === 'ArrowLeft')    { e.preventDefault(); if (activeId) testerBrowser.sessions.back(activeId);    return; }
  if (e.altKey && e.key === 'ArrowRight')   { e.preventDefault(); if (activeId) testerBrowser.sessions.forward(activeId); return; }
});

// Shortcuts forwarded from BrowserView via before-input-event
testerBrowser.sessions.onShortcut((key) => handleShortcut(key));

// ── IPC push events ────────────────────────────────────────────────────────

testerBrowser.sessions.onNavigated(({ id, url }) => {
  if (id === activeId) document.getElementById('urlbar').value = url;
});

testerBrowser.sessions.onNavState(({ id, canBack, canForward }) => {
  navState[id] = { canBack, canForward };
  if (id === activeId) updateNavButtons();
});

testerBrowser.sessions.onTitleUpdated(({ id, title }) => {
  tabTitles[id] = title;
  const nameEl = document.querySelector(`.tab[data-id="${id}"] .tab-name`);
  if (nameEl) nameEl.title = title;
});

testerBrowser.sessions.onFaviconUpdated(({ id, favicon }) => {
  tabFavicons[id] = favicon;
  refreshTabs();
});

testerBrowser.sessions.onTabCycle(({ reverse }) => cycleTab(reverse));

testerBrowser.sessions.onNewTab(({ id }) => { insertAfterActive(id); switchToSession(id); });

testerBrowser.sessions.onTabAction(({ action, id }) => {
  if (action === 'rename')  { const el = document.querySelector(`.tab[data-id="${id}"] .tab-name`); if (el) { clearTimeout(tabClickTimer); startRename(id, el); } }
  if (action === 'close')   closeTab(id);
  if (action === 'notes')   openNotes(id);
  if (action === 'refresh') refreshTabs();
});

// ── Console filter ─────────────────────────────────────────────────────────

function applyFilter() {
  const activeTypes = new Set([...document.querySelectorAll('.ftype:checked')].map((el) => el.value));
  const text = document.getElementById('filterText').value.toLowerCase();
  document.querySelectorAll('#timelinePanel .evt').forEach((el) => {
    const matches = activeTypes.has(el.dataset.kind) && (!text || (el.dataset.summary || '').toLowerCase().includes(text));
    el.style.display = matches ? '' : 'none';
  });
}

document.getElementById('filterText').addEventListener('input', applyFilter);
document.querySelectorAll('.ftype').forEach((cb) => cb.addEventListener('change', applyFilter));
document.getElementById('clearConsoleBtn').onclick = () => {
  document.getElementById('timelinePanel').innerHTML = '';
  lastTs = 0;
};

// ── Notes modal ────────────────────────────────────────────────────────────

async function openNotes(id) {
  notesSessionId = id;
  const sessions = await testerBrowser.sessions.list();
  const s = sessions.find((x) => x.id === id);
  document.getElementById('notesTitle').textContent = 'Notes — ' + (s?.name || id);
  document.getElementById('notesTextarea').value = await testerBrowser.sessions.getNotes(id);
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('notesOverlay').classList.add('open');
  document.getElementById('notesTextarea').focus();
}

async function closeNotes() {
  document.getElementById('notesOverlay').classList.remove('open');
  await testerBrowser.layout.setViewerVisible(true);
  notesSessionId = null;
}

document.getElementById('saveNotesBtn').onclick = async () => {
  if (notesSessionId) await testerBrowser.sessions.setNotes(notesSessionId, document.getElementById('notesTextarea').value);
  closeNotes();
};
document.getElementById('closeNotesBtn').onclick = () => closeNotes();
document.getElementById('notesOverlay').onclick = (e) => { if (e.target === document.getElementById('notesOverlay')) closeNotes(); };

// ── Settings modal ─────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  checking:        { cls: 'info', text: 'Checking for updates…' },
  available:       { cls: 'info', text: (v) => `Update ${v} found — downloading…` },
  downloading:     { cls: 'info', text: 'Downloading update…' },
  downloaded:      { cls: 'warn', text: (v) => `Update ${v} downloaded — restart to install` },
  'not-available': { cls: 'ok',   text: 'You\'re up to date' },
  error:           { cls: 'err',  text: (msg) => `Update error: ${msg || 'unknown'}` },
};

function applyUpdateStatus({ status, current, latest }) {
  document.getElementById('currentVersion').textContent = current || '—';
  document.getElementById('latestVersion').textContent  = latest || (status === 'not-available' ? current : '—');
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.checking;
  const el  = document.getElementById('updateStatusText');
  el.className   = cfg.cls;
  el.textContent = typeof cfg.text === 'function' ? cfg.text(latest) : cfg.text;
  document.getElementById('restartBtn').style.display = status === 'downloaded' ? '' : 'none';
}

async function openSettings() {
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('settingsOverlay').classList.add('open');
  applyUpdateStatus(await testerBrowser.app.getVersionInfo());
}
function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('open');
  testerBrowser.layout.setViewerVisible(true);
}

document.getElementById('closeSettingsBtn').onclick  = closeSettings;
document.getElementById('settingsOverlay').onclick   = (e) => { if (e.target === document.getElementById('settingsOverlay')) closeSettings(); };
document.getElementById('checkUpdatesBtn').onclick   = async () => {
  document.getElementById('updateStatusText').className   = 'info';
  document.getElementById('updateStatusText').textContent = 'Checking for updates…';
  document.getElementById('latestVersion').textContent    = '—';
  await testerBrowser.app.checkForUpdates();
};
document.getElementById('restartBtn').onclick = () => testerBrowser.app.restartAndInstall();

testerBrowser.app.onShowSettings(() => openSettings());
testerBrowser.app.onUpdateStatus((data) => applyUpdateStatus(data));

// ── Timeline polling ───────────────────────────────────────────────────────

async function pollTimeline() {
  if (activeId) {
    const events = await testerBrowser.recording.timeline(activeId, { since: lastTs || undefined, limit: 200 });
    const panel  = document.getElementById('timelinePanel');
    const activeTypes = new Set([...document.querySelectorAll('.ftype:checked')].map((el) => el.value));
    const filterText  = document.getElementById('filterText').value.toLowerCase();

    for (const e of events) {
      const visible = activeTypes.has(e.kind) && (!filterText || e.summary.toLowerCase().includes(filterText));
      const line    = document.createElement('div');
      line.className    = `evt ${e.kind}`;
      line.dataset.kind = e.kind;
      line.dataset.summary = e.summary;
      line.style.display   = visible ? '' : 'none';

      const summary = document.createElement('div');
      summary.className   = 'evt-summary';
      summary.textContent = `[${new Date(e.ts).toLocaleTimeString()}] ${e.summary}`;
      line.appendChild(summary);

      if (e.payload) {
        const detail = document.createElement('pre');
        detail.className = 'evt-detail';
        try { detail.textContent = JSON.stringify(JSON.parse(e.payload), null, 2); }
        catch { detail.textContent = e.payload; }
        line.appendChild(detail);
        summary.style.cursor = 'pointer';
        summary.onclick = () => detail.classList.toggle('open');
      }

      panel.appendChild(line);
      lastTs = Math.max(lastTs, e.ts);
    }
    if (events.length) panel.scrollTop = panel.scrollHeight;
  }
  setTimeout(pollTimeline, 1000);
}

// ── Boot ───────────────────────────────────────────────────────────────────

refreshTabs();
pollTimeline();
