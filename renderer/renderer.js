/* global testerBrowser */

// ── State ──────────────────────────────────────────────────────────────────

let activeId       = null;
let lastTs         = 0;
let sessionCounter = 0;
let mruStack       = [];
let tabOrder       = [];
let tabClickTimer  = null;
let dragSourceId   = null;

const tabFavicons = {};   // id → favicon url
const tabTitles   = {};   // id → page title
const navState    = {};   // id → { canBack, canForward }
const tabLoading  = {};   // id → boolean

const closedTabs  = [];   // [{ name, url, partition, color }] — most recent last

const timelineEvents = []; // ring buffer, max 5000 entries
const TIMELINE_MAX   = 5000;
const TIMELINE_DOM_MAX = 500; // max DOM nodes rendered at once

let notesSessionId = null;

// ── Layout constants ───────────────────────────────────────────────────────

const TOPBAR_BASE      = 91; // 40px tabs + 46px toolbar + 2px border + 3px loading bar
const FIND_BAR_H       = 40;
const BOOKMARKS_BAR_H  = 32;
const CONSOLE_DEFAULT  = 220;

let consoleHeight       = CONSOLE_DEFAULT;
let findOpen            = false;
let bookmarksBarVisible = false;

function updateTopBarHeight() {
  let h = TOPBAR_BASE;
  if (bookmarksBarVisible) h += BOOKMARKS_BAR_H;
  if (findOpen) h += FIND_BAR_H;
  testerBrowser.layout.setTopBarHeight(h);
  document.getElementById('downloadsPanel').style.top         = h + 'px';
  document.getElementById('permissionNotifications').style.top = h + 'px';
}

// ── Console resize ─────────────────────────────────────────────────────────

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

// ── Loading indicator ──────────────────────────────────────────────────────

const loadingBar = document.getElementById('loadingBar');
const reloadBtn  = document.getElementById('reloadBtn');

function setLoadingBar(loading) {
  loadingBar.classList.toggle('loading', loading);
}

function updateReloadBtn() {
  if (tabLoading[activeId]) {
    reloadBtn.innerHTML = '&#10005;';
    reloadBtn.title     = 'Stop loading (Esc)';
    reloadBtn.onclick   = () => activeId && testerBrowser.sessions.stop(activeId);
  } else {
    reloadBtn.innerHTML = '&#8635;';
    reloadBtn.title     = 'Reload (F5)';
    reloadBtn.onclick   = () => activeId && testerBrowser.sessions.reload(activeId);
  }
}

testerBrowser.sessions.onLoading(({ id, loading }) => {
  tabLoading[id] = loading;
  const tab = document.querySelector(`.tab[data-id="${id}"]`);
  if (tab) updateTabLoadingVisual(tab, id);
  if (id === activeId) {
    updateReloadBtn();
    setLoadingBar(loading);
  }
});

testerBrowser.sessions.onLoadFailed(({ id, errorCode, errorDescription, url }) => {
  if (id !== activeId) return;
  timelineEvents.push({
    kind: 'network-failed',
    summary: `LOAD FAILED (${errorCode}) ${errorDescription} — ${url}`,
    ts: Date.now(),
  });
  if (timelineEvents.length > TIMELINE_MAX) {
    timelineEvents.splice(0, timelineEvents.length - TIMELINE_MAX);
  }
  renderTimeline();
});

function updateTabLoadingVisual(tab, id) {
  const existing = tab.querySelector('.tab-spinner, .tab-favicon, .tab-dot');
  if (!existing) return;
  if (tabLoading[id]) {
    if (!tab.querySelector('.tab-spinner')) {
      const spinner = document.createElement('span');
      spinner.className = 'tab-spinner';
      existing.replaceWith(spinner);
    }
  } else {
    if (tab.querySelector('.tab-spinner')) {
      // Restore favicon or dot
      if (tabFavicons[id]) {
        const img = document.createElement('img');
        img.className = 'tab-favicon';
        img.src = tabFavicons[id];
        img.onerror = () => img.remove();
        tab.querySelector('.tab-spinner').replaceWith(img);
      } else {
        // We need session info to know persistent/ephemeral — just refresh tabs
        refreshTabs();
      }
    }
  }
}

// ── Zoom display ───────────────────────────────────────────────────────────

const zoomIndicator = document.getElementById('zoomIndicator');

function updateZoomDisplay(zoom) {
  if (Math.abs(zoom - 1) < 0.005) {
    zoomIndicator.style.display = 'none';
  } else {
    zoomIndicator.style.display = '';
    zoomIndicator.textContent = Math.round(zoom * 100) + '%';
  }
}

zoomIndicator.onclick = () => activeId && testerBrowser.sessions.resetZoom(activeId);

testerBrowser.sessions.onZoomChanged(({ id, zoom }) => {
  if (id === activeId) updateZoomDisplay(zoom);
});

// ── Bookmarks ──────────────────────────────────────────────────────────────

let bookmarks = [];
let urlHistory = [];

async function loadBookmarks() {
  bookmarks = await testerBrowser.bookmarks.list();
  renderBookmarksBar();
  updateBookmarkStar();
}

async function loadUrlHistory() {
  urlHistory = await testerBrowser.urlHistory.get();
  refreshUrlDatalist();
}

function refreshUrlDatalist() {
  const dl = document.getElementById('urlHistoryList');
  dl.innerHTML = '';
  for (const url of urlHistory) {
    const opt = document.createElement('option');
    opt.value = url;
    dl.appendChild(opt);
  }
}

function renderBookmarksBar() {
  const bar = document.getElementById('bookmarksBar');
  bar.innerHTML = '';
  for (const bm of bookmarks) {
    const btn = document.createElement('button');
    btn.className = 'bm-btn';
    btn.title     = bm.url;

    const label = document.createElement('span');
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0';
    label.textContent = bm.title || bm.url;
    btn.appendChild(label);

    const rm = document.createElement('span');
    rm.className   = 'bm-remove';
    rm.textContent = '×';
    rm.title       = 'Remove bookmark';
    rm.onclick = async (e) => {
      e.stopPropagation();
      bookmarks = await testerBrowser.bookmarks.remove(bm.url);
      renderBookmarksBar();
      updateBookmarkStar();
    };
    btn.appendChild(rm);
    btn.onclick = (e) => { if (e.target !== rm) { activeId && testerBrowser.sessions.navigate(activeId, bm.url); } };
    bar.appendChild(btn);
  }
}

function updateBookmarkStar() {
  const starBtn    = document.getElementById('bookmarkBtn');
  const currentUrl = document.getElementById('urlbar').value;
  const isBookmarked = bookmarks.some(b => b.url === currentUrl);
  starBtn.innerHTML  = isBookmarked ? '&#9733;' : '&#9734;';
  starBtn.title      = isBookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
  starBtn.classList.toggle('bookmarked', isBookmarked);
}

async function toggleBookmark() {
  const url = document.getElementById('urlbar').value;
  if (!url || url === 'https://example.com') return;
  const tabEl    = document.querySelector(`.tab[data-id="${activeId}"] .tab-name`);
  const title    = tabTitles[activeId] || tabEl?.textContent || url;
  const isBookmarked = bookmarks.some(b => b.url === url);
  if (isBookmarked) {
    bookmarks = await testerBrowser.bookmarks.remove(url);
  } else {
    bookmarks = await testerBrowser.bookmarks.add(url, title);
  }
  renderBookmarksBar();
  updateBookmarkStar();
}

function toggleBookmarksBar() {
  bookmarksBarVisible = !bookmarksBarVisible;
  document.getElementById('bookmarksBar').classList.toggle('open', bookmarksBarVisible);
  updateTopBarHeight();
}

document.getElementById('bookmarkBtn').onclick = () => toggleBookmark();

// ── Downloads ──────────────────────────────────────────────────────────────

const dlMap        = new Map(); // id → download object
let downloadsOpen  = false;

function formatBytes(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function updateDownloadsBadge() {
  const active = [...dlMap.values()].filter(d => d.state === 'progressing').length;
  const badge  = document.getElementById('downloadsBadge');
  badge.style.display = active > 0 ? 'flex' : 'none';
  badge.textContent   = active;
}

function renderDownloads() {
  const list = document.getElementById('downloadsList');
  list.innerHTML = '';
  const sorted = [...dlMap.values()].sort((a, b) => {
    if (a.state === 'progressing' && b.state !== 'progressing') return -1;
    if (b.state === 'progressing' && a.state !== 'progressing') return 1;
    return b.id < a.id ? 1 : -1;
  });
  if (sorted.length === 0) {
    list.innerHTML = '<div class="dl-empty">No downloads</div>';
    return;
  }
  for (const dl of sorted) {
    const item = document.createElement('div');
    item.className = 'dl-item';

    const name = document.createElement('div');
    name.className   = 'dl-name';
    name.textContent = dl.filename;
    name.title       = dl.url;
    item.appendChild(name);

    if (dl.state === 'progressing') {
      const pct  = dl.totalBytes > 0 ? Math.round(dl.receivedBytes / dl.totalBytes * 100) : 0;
      const prog = document.createElement('div');
      prog.className = 'dl-progress';
      const bar = document.createElement('div');
      bar.className    = 'dl-progress-bar';
      bar.style.width  = pct + '%';
      prog.appendChild(bar);
      item.appendChild(prog);
      const info = document.createElement('div');
      info.className   = 'dl-info';
      info.textContent = dl.totalBytes > 0
        ? `${formatBytes(dl.receivedBytes)} / ${formatBytes(dl.totalBytes)} (${pct}%)`
        : formatBytes(dl.receivedBytes);
      item.appendChild(info);
    } else {
      const info = document.createElement('div');
      info.className   = 'dl-info ' + (dl.state === 'completed' ? 'ok' : 'err');
      info.textContent = dl.state === 'completed' ? formatBytes(dl.receivedBytes) : dl.state;
      item.appendChild(info);
    }

    const actions = document.createElement('div');
    actions.className = 'dl-actions';
    if (dl.state === 'completed') {
      const openBtn = document.createElement('button');
      openBtn.className   = 'dl-btn';
      openBtn.textContent = 'Open';
      openBtn.onclick = () => testerBrowser.downloads.open(dl.id);
      const revealBtn = document.createElement('button');
      revealBtn.className   = 'dl-btn';
      revealBtn.textContent = 'Show in folder';
      revealBtn.onclick = () => testerBrowser.downloads.reveal(dl.id);
      actions.appendChild(openBtn);
      actions.appendChild(revealBtn);
    } else if (dl.state === 'progressing') {
      const cancelBtn = document.createElement('button');
      cancelBtn.className   = 'dl-btn dl-btn-danger';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => testerBrowser.downloads.cancel(dl.id);
      actions.appendChild(cancelBtn);
    }
    item.appendChild(actions);
    list.appendChild(item);
  }
}

function toggleDownloads() {
  downloadsOpen = !downloadsOpen;
  document.getElementById('downloadsPanel').classList.toggle('open', downloadsOpen);
  if (downloadsOpen) renderDownloads();
}

testerBrowser.downloads.onUpdate((dl) => {
  dlMap.set(dl.id, dl);
  updateDownloadsBadge();
  if (downloadsOpen) renderDownloads();
  // Auto-open panel on first download
  if (dl.state === 'progressing' && !downloadsOpen) toggleDownloads();
});

testerBrowser.downloads.onCleared(() => {
  for (const [id, dl] of dlMap) if (dl.state !== 'progressing') dlMap.delete(id);
  updateDownloadsBadge();
  if (downloadsOpen) renderDownloads();
});

document.getElementById('downloadsBtn').onclick   = () => toggleDownloads();
document.getElementById('closeDownloadsBtn').onclick = () => { downloadsOpen = false; document.getElementById('downloadsPanel').classList.remove('open'); };
document.getElementById('clearDownloadsBtn').onclick = () => testerBrowser.downloads.clear();

// ── Permission notifications ────────────────────────────────────────────────

const PERM_LABELS = {
  geolocation:       'access your location',
  notifications:     'show notifications',
  camera:            'access your camera',
  microphone:        'access your microphone',
  media:             'access your camera and microphone',
  midi:              'access MIDI devices',
  'clipboard-read':  'read the clipboard',
  'clipboard-write': 'write to the clipboard',
};

testerBrowser.permission.onRequest(({ reqId, permission, origin }) => {
  const notif = document.createElement('div');
  notif.className = 'perm-notif';

  const msg = document.createElement('span');
  msg.className   = 'perm-msg';
  msg.textContent = `${origin} wants to ${PERM_LABELS[permission] || permission}`;
  notif.appendChild(msg);

  const allow = document.createElement('button');
  allow.className   = 'perm-btn perm-allow';
  allow.textContent = 'Allow';
  allow.onclick = () => { testerBrowser.permission.respond(reqId, true);  notif.remove(); };
  notif.appendChild(allow);

  const block = document.createElement('button');
  block.className   = 'perm-btn perm-block';
  block.textContent = 'Block';
  block.onclick = () => { testerBrowser.permission.respond(reqId, false); notif.remove(); };
  notif.appendChild(block);

  document.getElementById('permissionNotifications').appendChild(notif);
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
  timelineEvents.length = 0;
  document.getElementById('timelinePanel').innerHTML = '';
  if (activeConsoleTab === 'storage') loadStoragePanel();
  recordVisit(id);
  await testerBrowser.sessions.switchTo(id);
  updateNavButtons();
  updateReloadBtn();
  setLoadingBar(tabLoading[id] || false);
  updateZoomDisplay(1); // session:zoomChanged will arrive immediately after switchTo
  await refreshTabs();
}

function cycleTab(reverse) {
  if (mruStack.length < 2) return;
  switchToSession(reverse ? mruStack[mruStack.length - 1] : mruStack[1]);
}

function updateNavButtons() {
  const ns = navState[activeId] || {};
  document.getElementById('backBtn').disabled = !ns.canBack;
  document.getElementById('fwdBtn').disabled  = !ns.canForward;
}

// ── Tab rendering ──────────────────────────────────────────────────────────

async function refreshTabs() {
  const sessions   = await testerBrowser.sessions.list();
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));

  tabOrder = tabOrder.filter((id) => sessionMap.has(id));
  for (const s of sessions) if (!tabOrder.includes(s.id)) tabOrder.push(s.id);

  const tabsEl = document.getElementById('tabs');
  tabsEl.querySelectorAll('.tab').forEach((el) => el.remove());

  for (const id of tabOrder) {
    const s = sessionMap.get(id);

    const tab = document.createElement('span');
    tab.className  = 'tab' + (s.id === activeId ? ' active' : '');
    tab.dataset.id = s.id;
    if (s.color) tab.style.setProperty('--tab-color', s.color);

    // Favicon / dot / spinner
    if (tabLoading[s.id]) {
      const spinner = document.createElement('span');
      spinner.className = 'tab-spinner';
      tab.appendChild(spinner);
    } else if (tabFavicons[s.id]) {
      const img = document.createElement('img');
      img.className = 'tab-favicon';
      img.src = tabFavicons[s.id];
      img.onerror = () => img.remove();
      tab.appendChild(img);
    } else {
      const dot = document.createElement('span');
      dot.className = 'tab-dot ' + (s.persistent ? 'persistent' : 'ephemeral');
      dot.title     = s.persistent ? 'Persistent session' : 'In-memory session';
      tab.appendChild(dot);
    }

    if (s.pinned) {
      const pin = document.createElement('span');
      pin.className   = 'tab-pin';
      pin.textContent = '📌';
      tab.appendChild(pin);
    }

    const name = document.createElement('span');
    name.className   = 'tab-name';
    name.textContent = s.name;
    name.title       = tabTitles[s.id] || s.name;
    name.onclick = () => {
      clearTimeout(tabClickTimer);
      tabClickTimer = setTimeout(() => switchToSession(s.id), 250);
    };
    name.ondblclick = (e) => { e.stopPropagation(); clearTimeout(tabClickTimer); startRename(s.id, name); };
    tab.appendChild(name);

    if (!s.pinned) {
      const x = document.createElement('span');
      x.className   = 'tab-close';
      x.textContent = '×';
      x.title       = 'Close (Ctrl+W)';
      x.onclick     = (e) => { e.stopPropagation(); closeTab(s.id); };
      tab.appendChild(x);
    }

    tab.oncontextmenu = (e) => { e.preventDefault(); testerBrowser.sessions.contextMenu(s.id); };

    // Drag-to-reorder
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

    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1 && !s.pinned) { e.preventDefault(); e.stopPropagation(); closeTab(s.id); }
    });

    tabsEl.insertBefore(tab, document.getElementById('newSessionBtn'));
  }

  mruStack = mruStack.filter((id) => sessionMap.has(id));
  if (!activeId && sessions.length) { activeId = sessions[0].id; recordVisit(activeId); }

  // Update URL bar and bookmark star for active session
  const active = sessionMap.get(activeId);
  if (active) {
    document.getElementById('urlbar').value = active.url || '';
    updateBookmarkStar();
  }

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

  // Warn if there are unsaved notes on a non-persistent session
  if (s && !s.persistent) {
    const notes = await testerBrowser.sessions.getNotes(id);
    if (notes && notes.trim()) {
      const ok = confirm(`"${s.name}" is an in-memory session with notes.\n\nNotes will be lost when the tab is closed. Close anyway?`);
      if (!ok) return;
    }
  }

  if (s) closedTabs.push({ name: s.name, url: s.url || 'https://example.com', partition: s.partition, color: s.color });
  if (closedTabs.length > 20) closedTabs.shift();

  await testerBrowser.sessions.destroy(id);
  tabOrder = tabOrder.filter((x) => x !== id);
  mruStack = mruStack.filter((x) => x !== id);
  delete tabFavicons[id];
  delete tabTitles[id];
  delete navState[id];
  delete tabLoading[id];

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

// ── New tab ────────────────────────────────────────────────────────────────

document.getElementById('newSessionBtn').onclick = async () => {
  sessionCounter++;
  const id = await testerBrowser.sessions.create(`Session ${sessionCounter}`, { persistent: false });
  insertAfterActive(id);
  await switchToSession(id);
};

// ── Nav buttons ────────────────────────────────────────────────────────────

document.getElementById('backBtn').onclick    = () => activeId && testerBrowser.sessions.back(activeId);
document.getElementById('fwdBtn').onclick     = () => activeId && testerBrowser.sessions.forward(activeId);
document.getElementById('devtoolsBtn').onclick = () => activeId && testerBrowser.sessions.devtools(activeId);
// reloadBtn.onclick is managed by updateReloadBtn()

// ── URL bar ────────────────────────────────────────────────────────────────

document.getElementById('urlbar').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && activeId) {
    const url = e.target.value;
    await testerBrowser.sessions.navigate(activeId, url);
    // Record in history (normalise to https:// if bare)
    const fullUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    urlHistory = await testerBrowser.urlHistory.add(fullUrl);
    refreshUrlDatalist();
    e.target.blur();
  }
  if (e.key === 'Escape') e.target.blur();
});

// ── Find bar ───────────────────────────────────────────────────────────────

const findBar   = document.getElementById('findBar');
const findInput = document.getElementById('findInput');
let findText    = '';

function openFind() {
  if (!findOpen) {
    findOpen = true;
    findBar.classList.add('open');
    updateTopBarHeight();
  }
  findInput.focus(); findInput.select();
}

function closeFind() {
  if (!findOpen) return;
  findOpen = false;
  findBar.classList.remove('open');
  findInput.classList.remove('no-match');
  document.getElementById('findCount').textContent = '';
  updateTopBarHeight();
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
document.getElementById('findNextBtn').onclick  = () => doFind(true,  true);
document.getElementById('findCloseBtn').onclick = () => closeFind();

testerBrowser.sessions.onFindResult(({ id, matches, activeMatch }) => {
  if (id !== activeId) return;
  const count = document.getElementById('findCount');
  if (matches === 0) { count.textContent = 'No results'; findInput.classList.add('no-match'); }
  else { count.textContent = `${activeMatch}/${matches}`; findInput.classList.remove('no-match'); }
});

// ── Keyboard shortcuts ─────────────────────────────────────────────────────

function handleShortcut(key) {
  switch (key) {
    case 'newTab':             document.getElementById('newSessionBtn').onclick(); break;
    case 'closeTab':           if (activeId) closeTab(activeId); break;
    case 'reopenTab':          reopenTab(); break;
    case 'focusUrl':           { const u = document.getElementById('urlbar'); u.focus(); u.select(); } break;
    case 'reload':             if (activeId) testerBrowser.sessions.reload(activeId); break;
    case 'findToggle':         findOpen ? closeFind() : openFind(); break;
    case 'findNext':           doFind(true,  true); break;
    case 'findPrev':           doFind(false, true); break;
    case 'bookmark':           toggleBookmark(); break;
    case 'toggleBookmarksBar': toggleBookmarksBar(); break;
    case 'stopOrEsc':
      if (activeId && tabLoading[activeId]) testerBrowser.sessions.stop(activeId);
      else if (findOpen) closeFind();
      break;
    default:
      if (key.startsWith('switchTab:')) {
        const n = parseInt(key.slice(10)) - 1;
        // Ctrl+9 always goes to last tab (Chrome behaviour)
        const targetId = n === 8 ? tabOrder[tabOrder.length - 1] : tabOrder[n];
        if (targetId) switchToSession(targetId);
      }
  }
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Tab')         { e.preventDefault(); cycleTab(e.shiftKey); return; }
  if (e.ctrlKey && !e.shiftKey && e.key === 't') { e.preventDefault(); handleShortcut('newTab');    return; }
  if (e.ctrlKey && !e.shiftKey && e.key === 'w') { e.preventDefault(); handleShortcut('closeTab');  return; }
  if (e.ctrlKey && e.shiftKey  && e.key === 'T') { e.preventDefault(); handleShortcut('reopenTab'); return; }
  if (e.ctrlKey && e.key === 'l')           { e.preventDefault(); handleShortcut('focusUrl');          return; }
  if (e.ctrlKey && e.key === 'f')           { e.preventDefault(); handleShortcut('findToggle');        return; }
  if (e.ctrlKey && !e.shiftKey && e.key === 'd') { e.preventDefault(); handleShortcut('bookmark');    return; }
  if (e.ctrlKey && e.shiftKey && e.key === 'B')  { e.preventDefault(); handleShortcut('toggleBookmarksBar'); return; }
  if (e.key === 'F3')                       { e.preventDefault(); handleShortcut(e.shiftKey ? 'findPrev' : 'findNext'); return; }
  if ((e.ctrlKey && e.key === 'r') || e.key === 'F5') { e.preventDefault(); handleShortcut('reload'); return; }
  if (e.key === 'Escape')                   { e.preventDefault(); handleShortcut('stopOrEsc'); return; }
  if (e.key === 'F12')                      { e.preventDefault(); if (activeId) testerBrowser.sessions.devtools(activeId); return; }
  if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); if (activeId) testerBrowser.sessions.setZoom(activeId, 0.1);  return; }
  if (e.ctrlKey && e.key === '-')           { e.preventDefault(); if (activeId) testerBrowser.sessions.setZoom(activeId, -0.1); return; }
  if (e.ctrlKey && e.key === '0')           { e.preventDefault(); if (activeId) testerBrowser.sessions.resetZoom(activeId);    return; }
  if (e.altKey  && e.key === 'ArrowLeft')   { e.preventDefault(); if (activeId) testerBrowser.sessions.back(activeId);         return; }
  if (e.altKey  && e.key === 'ArrowRight')  { e.preventDefault(); if (activeId) testerBrowser.sessions.forward(activeId);      return; }
  if (e.ctrlKey && e.key >= '1' && e.key <= '9') { e.preventDefault(); handleShortcut(`switchTab:${e.key}`); return; }
});

// Shortcuts forwarded from BrowserView via before-input-event
testerBrowser.sessions.onShortcut((key) => handleShortcut(key));

// ── IPC push events ────────────────────────────────────────────────────────

testerBrowser.sessions.onNavigated(({ id, url }) => {
  if (id === activeId) {
    document.getElementById('urlbar').value = url;
    updateBookmarkStar();
  }
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
  renderTimeline();
}

function renderTimeline() {
  const panel      = document.getElementById('timelinePanel');
  const filterText = document.getElementById('filterText').value.toLowerCase();

  const activeTypes = new Set([...document.querySelectorAll('.filter-pill.on')].map(el => el.dataset.type));
  const filtered = timelineEvents.filter(e => {
    const kindVisible = activeTypes.has(e.kind) ||
      (e.kind === 'network-body' && activeTypes.has('network-response'));
    return kindVisible && (!filterText || e.summary.toLowerCase().includes(filterText));
  });

  const visible = filtered.slice(-TIMELINE_DOM_MAX);
  panel.innerHTML = '';

  if (filtered.length > TIMELINE_DOM_MAX) {
    const msg = document.createElement('div');
    msg.className   = 'evt-overflow-msg';
    msg.textContent = `▲ ${filtered.length - TIMELINE_DOM_MAX} older events not shown — clear filter or console to see them`;
    panel.appendChild(msg);
  }

  for (const e of visible) {
    const line = document.createElement('div');
    line.className       = `evt ${e.kind}`;
    line.dataset.kind    = e.kind;
    line.dataset.summary = e.summary;

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
  }

  panel.scrollTop = panel.scrollHeight;
}

document.getElementById('filterText').addEventListener('input', applyFilter);
document.querySelectorAll('.filter-pill').forEach((btn) => btn.addEventListener('click', () => { btn.classList.toggle('on'); applyFilter(); }));
document.getElementById('clearConsoleBtn').onclick = () => {
  timelineEvents.length = 0;
  lastTs = 0;
  document.getElementById('timelinePanel').innerHTML = '';
};
document.getElementById('exportHarBtn').onclick = async () => {
  if (!activeId) return;
  const har = await testerBrowser.recording.exportHAR(activeId);
  if (!har) return;
  const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `session-${activeId}.har`;
  a.click();
  URL.revokeObjectURL(url);
};

// ── Notes modal ────────────────────────────────────────────────────────────

async function openNotes(id) {
  notesSessionId = id;
  const sessions = await testerBrowser.sessions.list();
  const s = sessions.find((x) => x.id === id);
  document.getElementById('notesTitle').textContent    = 'Notes — ' + (s?.name || id);
  document.getElementById('notesTextarea').value       = await testerBrowser.sessions.getNotes(id);
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('notesOverlay').classList.add('open');
  document.getElementById('notesTextarea').focus();
}

async function closeNotes() {
  document.getElementById('notesOverlay').classList.remove('open');
  await testerBrowser.layout.setViewerVisible(true);
  notesSessionId = null;
}

document.getElementById('saveNotesBtn').onclick  = async () => {
  if (notesSessionId) await testerBrowser.sessions.setNotes(notesSessionId, document.getElementById('notesTextarea').value);
  closeNotes();
};
document.getElementById('closeNotesBtn').onclick = () => closeNotes();
document.getElementById('notesOverlay').onclick  = (e) => { if (e.target === document.getElementById('notesOverlay')) closeNotes(); };

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
    if (events.length > 0) {
      timelineEvents.push(...events);
      if (timelineEvents.length > TIMELINE_MAX) {
        timelineEvents.splice(0, timelineEvents.length - TIMELINE_MAX);
      }
      lastTs = Math.max(lastTs, ...events.map(e => e.ts));
      renderTimeline();
    }
  }
  setTimeout(pollTimeline, 1000);
}

// ── Console tabs ───────────────────────────────────────────────────────────

let activeConsoleTab = 'console';

function switchConsoleTab(tab) {
  activeConsoleTab = tab;
  document.getElementById('consoleTabConsole').classList.toggle('active', tab === 'console');
  document.getElementById('consoleTabStorage').classList.toggle('active', tab === 'storage');
  document.getElementById('consoleControls').style.display = tab === 'console' ? '' : 'none';
  document.getElementById('storageControls').style.display = tab === 'storage' ? 'flex' : 'none';
  document.getElementById('timelinePanel').style.display   = tab === 'console' ? '' : 'none';
  document.getElementById('storagePanel').style.display    = tab === 'storage' ? 'block' : 'none';
  if (tab === 'storage') loadStoragePanel();
}

document.getElementById('consoleTabConsole').addEventListener('click', () => switchConsoleTab('console'));
document.getElementById('consoleTabStorage').addEventListener('click', () => switchConsoleTab('storage'));
document.getElementById('refreshStorageBtn').addEventListener('click', loadStoragePanel);

// ── Storage panel ──────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadStoragePanel() {
  if (!activeId) return;
  const panel = document.getElementById('storagePanel');
  panel.innerHTML = '<div class="storage-empty">Loading…</div>';

  const [cookies, ls] = await Promise.all([
    testerBrowser.sessions.getCookies(activeId),
    testerBrowser.sessions.getLocalStorage(activeId),
  ]);

  panel.innerHTML = '';

  // Cookies
  const cookieHdr = document.createElement('div');
  cookieHdr.className = 'storage-section-header';
  cookieHdr.textContent = `Cookies (${cookies.length})`;
  panel.appendChild(cookieHdr);

  if (cookies.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'storage-empty';
    empty.textContent = 'No cookies for this session';
    panel.appendChild(empty);
  } else {
    const table = document.createElement('table');
    table.className = 'storage-table';
    table.innerHTML = '<thead><tr><th>Domain</th><th>Name</th><th>Value</th><th>Path</th><th>Secure</th><th>HttpOnly</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const c of cookies) {
      const tr = document.createElement('tr');
      const val = escHtml(c.value);
      tr.innerHTML = `
        <td>${escHtml(c.domain || '')}</td>
        <td>${escHtml(c.name)}</td>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${val}">${val}</td>
        <td>${escHtml(c.path || '/')}</td>
        <td><span class="storage-badge ${c.secure ? 'yes' : 'no'}">${c.secure ? '✓' : '—'}</span></td>
        <td><span class="storage-badge ${c.httpOnly ? 'yes' : 'no'}">${c.httpOnly ? '✓' : '—'}</span></td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
  }

  // Local Storage
  const lsEntries = Object.entries(ls);
  const lsHdr = document.createElement('div');
  lsHdr.className = 'storage-section-header';
  lsHdr.textContent = `Local Storage (${lsEntries.length})`;
  panel.appendChild(lsHdr);

  if (lsEntries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'storage-empty';
    empty.textContent = 'No local storage entries for this page';
    panel.appendChild(empty);
  } else {
    const table = document.createElement('table');
    table.className = 'storage-table';
    table.innerHTML = '<thead><tr><th style="width:35%">Key</th><th>Value</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const [k, v] of lsEntries) {
      const tr = document.createElement('tr');
      const val = escHtml(v);
      tr.innerHTML = `<td>${escHtml(k)}</td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${val}">${val}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
  }
}

// ── View dropdown ──────────────────────────────────────────────────────────

let consoleVisible = true;
const viewWrapper  = document.getElementById('viewWrapper');
const viewDropdown = document.getElementById('viewDropdown');

function updateViewDropdown() {
  document.getElementById('viewConsoleCheck').textContent   = consoleVisible      ? '✓' : '';
  document.getElementById('viewBookmarksCheck').textContent = bookmarksBarVisible ? '✓' : '';
}

document.getElementById('viewBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  viewDropdown.classList.toggle('open');
  updateViewDropdown();
});

document.addEventListener('click', (e) => {
  if (!viewWrapper.contains(e.target)) viewDropdown.classList.remove('open');
});

document.getElementById('viewToggleConsole').addEventListener('click', () => {
  consoleVisible = !consoleVisible;
  consolePanel.style.display = consoleVisible ? 'flex' : 'none';
  testerBrowser.layout.setConsoleHeight(consoleVisible ? consoleHeight : 0);
  updateViewDropdown();
});

document.getElementById('viewToggleBookmarks').addEventListener('click', () => {
  toggleBookmarksBar();
  updateViewDropdown();
  viewDropdown.classList.remove('open');
});

// ── Boot ───────────────────────────────────────────────────────────────────

refreshTabs();
loadBookmarks();
loadUrlHistory();
pollTimeline();
