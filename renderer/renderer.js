/* DEPRECATED — renderer logic has been split into ES modules under renderer/*.js
 * The entry point is now main.js (loaded as <script type="module" src="main.js">).
 * This file is kept for reference only and is not loaded by index.html. */

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
let domainFilterActive = true;

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
    if (activeConsoleTab === 'storage') loadStoragePanel();
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

// ── Auto-scroll tracking ───────────────────────────────────────────────────

let autoScroll = true;
const timelinePanel    = document.getElementById('timelinePanel');
const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');

timelinePanel.addEventListener('scroll', () => {
  autoScroll = timelinePanel.scrollTop + timelinePanel.clientHeight >= timelinePanel.scrollHeight - 30;
  scrollToBottomBtn.classList.toggle('visible', !autoScroll);
});

scrollToBottomBtn.onclick = () => {
  timelinePanel.scrollTop = timelinePanel.scrollHeight;
  autoScroll = true;
  scrollToBottomBtn.classList.remove('visible');
};

function applyFilter() {
  renderTimeline();
}

// ── Detail panel (request side panel) ──────────────────────────────────────

let detailTabs = [];
let activeDetailTabId = null;

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusClass(code) {
  if (!code) return 'detail-status-err';
  if (code < 300) return 'detail-status-ok';
  if (code < 400) return 'detail-status-redir';
  return 'detail-status-err';
}

function methodClass(method) {
  const m = String(method || '').toUpperCase();
  return ['GET','POST','PUT','DELETE','PATCH'].includes(m) ? `detail-method-${m}` : 'detail-method-other';
}

function getEventTabId(e) {
  if (e.payload && e.kind.startsWith('network-')) {
    try {
      const p = JSON.parse(e.payload);
      if (p.requestId) return p.requestId;
    } catch {}
  }
  return `${e.ts}-${e.kind}`;
}

function getEventTabLabel(e) {
  if (e.kind === 'network-request' || e.kind === 'network-response') {
    const m = e.summary.match(/^([A-Z]+)\s+(.+)$/);
    if (m) {
      let path = m[2];
      try { path = new URL(m[2]).pathname || '/'; } catch {}
      return `${m[1]} ${path.length > 18 ? path.slice(0, 18) + '…' : path}`;
    }
  }
  return e.summary.length > 22 ? e.summary.slice(0, 22) + '…' : e.summary;
}

function openDetailTab(e) {
  const tabId = getEventTabId(e);
  const existing = detailTabs.find(t => t.id === tabId);
  if (existing) {
    activeDetailTabId = tabId;
  } else {
    detailTabs.push({ id: tabId, event: e, label: getEventTabLabel(e) });
    activeDetailTabId = tabId;
  }
  renderDetailPanel();
}

function closeDetailTab(tabId) {
  const idx = detailTabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  detailTabs.splice(idx, 1);
  if (activeDetailTabId === tabId) {
    activeDetailTabId = detailTabs.length > 0 ? detailTabs[Math.max(0, idx - 1)].id : null;
  }
  renderDetailPanel();
}

function renderDetailTabs() {
  const bar = document.getElementById('detailPanelTabBar');
  bar.innerHTML = '';
  for (const tab of detailTabs) {
    const btn = document.createElement('button');
    btn.className = `detail-tab${tab.id === activeDetailTabId ? ' active' : ''}`;
    btn.title = tab.event.summary;

    const lbl = document.createElement('span');
    lbl.className = 'detail-tab-label';
    lbl.textContent = tab.label;

    const cls = document.createElement('span');
    cls.className = 'detail-tab-close';
    cls.textContent = '×';
    cls.onclick = (ev) => { ev.stopPropagation(); closeDetailTab(tab.id); };

    btn.appendChild(lbl);
    btn.appendChild(cls);
    btn.onclick = () => { activeDetailTabId = tab.id; renderDetailPanel(); };
    bar.appendChild(btn);
  }
}

function renderDetailContent() {
  const content = document.getElementById('detailPanelContent');
  if (!activeDetailTabId) { content.innerHTML = ''; return; }
  const tab = detailTabs.find(t => t.id === activeDetailTabId);
  if (!tab) { content.innerHTML = ''; return; }

  const e = tab.event;
  let html = '';

  try {
    if (e.kind.startsWith('network-')) {
      // Aggregate all events for this requestId from the timeline
      const rid = activeDetailTabId;
      const reqEvt  = timelineEvents.find(ev => ev.kind === 'network-request'  && getEventTabId(ev) === rid);
      const resEvt  = timelineEvents.find(ev => ev.kind === 'network-response' && getEventTabId(ev) === rid);
      const bodyEvt = timelineEvents.find(ev => ev.kind === 'network-body'     && getEventTabId(ev) === rid);
      const failEvt = timelineEvents.find(ev => ev.kind === 'network-failed'   && getEventTabId(ev) === rid);

      // ── Request section ──
      if (reqEvt && reqEvt.payload) {
        const req = (JSON.parse(reqEvt.payload).request) || {};
        html += `<div class="detail-section">
          <span class="detail-method ${methodClass(req.method)}">${escHtml(req.method || '?')}</span>
          <span class="detail-url">${escHtml(req.url || '')}</span>
        </div>`;
        if (req.headers && Object.keys(req.headers).length) {
          html += `<div class="detail-section"><h3>Request Headers</h3><table class="headers-table">`;
          for (const [k, v] of Object.entries(req.headers)) {
            html += `<tr><td>${escHtml(k)}</td><td>${escHtml(String(v))}</td></tr>`;
          }
          html += `</table></div>`;
        }
        if (req.postData) {
          html += `<div class="detail-section"><h3>Request Body</h3><pre class="detail-body-pre">${escHtml(req.postData)}</pre></div>`;
        }
      }

      // ── Response section ──
      if (resEvt && resEvt.payload) {
        const res = (JSON.parse(resEvt.payload).response) || {};
        html += `<div class="detail-section">
          <h3>Response</h3>
          <span class="${statusClass(res.status)}">${escHtml(String(res.status || ''))}</span>
          <span style="color:#666;margin:0 6px">${escHtml(res.statusText || '')}</span>
        </div>`;
        if (res.headers && Object.keys(res.headers).length) {
          html += `<div class="detail-section"><h3>Response Headers</h3><table class="headers-table">`;
          for (const [k, v] of Object.entries(res.headers)) {
            html += `<tr><td>${escHtml(k)}</td><td>${escHtml(String(v))}</td></tr>`;
          }
          html += `</table></div>`;
        }
      } else if (!resEvt && !failEvt) {
        html += `<div class="detail-section"><span style="color:#555;font-size:11px">Waiting for response…</span></div>`;
      }

      // ── Body section ──
      if (bodyEvt && bodyEvt.payload) {
        const bp = JSON.parse(bodyEvt.payload);
        html += `<div class="detail-section"><h3>Response Body</h3>`;
        if (bp.base64Encoded) html += `<div style="color:#555;font-size:11px;margin-bottom:4px">[base64 encoded]</div>`;
        html += `<pre class="detail-body-pre">${escHtml(String(bp.body || ''))}</pre></div>`;
      }

      // ── Failure section ──
      if (failEvt && failEvt.payload) {
        const fp = JSON.parse(failEvt.payload);
        html += `<div class="detail-section"><h3 style="color:#ff8080">Request Failed</h3>
          <div style="color:#ff8080">${escHtml(fp.errorText || 'Unknown error')}</div>`;
        if (fp.canceled) html += `<div style="color:#555;font-size:11px;margin-top:4px">Request was canceled</div>`;
        html += `</div>`;
      }

      if (!html) html = `<pre class="detail-body-pre">${escHtml(e.payload || e.summary)}</pre>`;
    } else {
      // Console / log events
      const p = e.payload ? JSON.parse(e.payload) : null;
      html += `<div class="detail-section"><h3>${escHtml(e.kind)}</h3>
        <pre class="detail-body-pre">${escHtml(p ? JSON.stringify(p, null, 2) : e.summary)}</pre></div>`;
    }
  } catch {
    html += `<pre class="detail-body-pre">${escHtml(e.payload || e.summary)}</pre>`;
  }
  content.innerHTML = html;
}

function renderDetailPanel() {
  const panel = document.getElementById('detailPanel');
  const resizeHandle = document.getElementById('detailPanelResizeHandle');
  const isConsoleTab = activeConsoleTab === 'console';
  const hasOpen = detailTabs.length > 0 && isConsoleTab;
  panel.classList.toggle('open', hasOpen);
  resizeHandle.style.display = hasOpen ? '' : 'none';
  renderDetailTabs();
  renderDetailContent();
  renderTimeline();
}

// Detail panel horizontal resize
(function () {
  const handle = document.getElementById('detailPanelResizeHandle');
  const panel  = document.getElementById('detailPanel');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    const onMove = (ev) => {
      const newW = Math.max(200, Math.min(startW + (startX - ev.clientX), window.innerWidth - 300));
      panel.style.width = newW + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
})();

function renderTimeline() {
  const panel      = timelinePanel;
  const filterText = document.getElementById('filterText').value.toLowerCase();

  const activeTypes = new Set([...document.querySelectorAll('.filter-pill.on')].map(el => el.dataset.type));
  const filtered = timelineEvents.filter(e => {
    const kindVisible = activeTypes.has(e.kind) ||
      (e.kind === 'network-body' && activeTypes.has('network-response'));
    return kindVisible && (!filterText || e.summary.toLowerCase().includes(filterText));
  });

  // Update pill count badges from raw (unfiltered) totals
  const kindCounts = {};
  for (const e of timelineEvents) kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1;
  document.querySelectorAll('.filter-pill').forEach(btn => {
    const n = kindCounts[btn.dataset.type] || 0;
    const span = btn.querySelector('.pill-count');
    if (span) span.textContent = n > 0 ? n : '';
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
    // Determine console subtype class
    let subtypeClass = '';
    if (e.kind === 'console') {
      const m = e.summary.match(/^\[(\w+)\]/);
      if (m) subtypeClass = ' console-' + m[1].toLowerCase();
    }
    const tabId = getEventTabId(e);
    const line = document.createElement('div');
    line.className       = `evt ${e.kind}${subtypeClass}`;
    line.dataset.kind    = e.kind;
    line.dataset.summary = e.summary;
    line.dataset.tabId   = tabId;
    if (detailTabs.some(t => t.id === tabId)) line.classList.add('detail-row-active');

    const summary = document.createElement('div');
    summary.className   = 'evt-summary';
    summary.textContent = `[${new Date(e.ts).toLocaleTimeString()}] ${e.summary}`;
    line.appendChild(summary);

    if (e.kind === 'network-request' && e.payload) {
      const replayBtn = document.createElement('button');
      replayBtn.className = 'evt-replay-btn';
      replayBtn.textContent = '↺ Replay';
      replayBtn.title = 'Edit and replay this request';
      replayBtn.onclick = (ev) => { ev.stopPropagation(); openReplay(e); };
      summary.appendChild(replayBtn);
    }

    if (e.payload) {
      summary.style.cursor = 'pointer';
      summary.addEventListener('click', (ev) => {
        if (!ev.target.closest('.evt-replay-btn')) openDetailTab(e);
      });
    }

    panel.appendChild(line);
  }

  if (autoScroll) panel.scrollTop = panel.scrollHeight;
}

document.getElementById('filterText').addEventListener('input', applyFilter);
document.querySelectorAll('.filter-pill').forEach((btn) => btn.addEventListener('click', () => { btn.classList.toggle('on'); applyFilter(); }));
document.getElementById('clearConsoleBtn').onclick = () => {
  timelineEvents.length = 0;
  lastTs = 0;
  timelinePanel.innerHTML = '';
  document.querySelectorAll('.filter-pill .pill-count').forEach(s => { s.textContent = ''; });
  autoScroll = true;
  scrollToBottomBtn.classList.remove('visible');
};

// ── Request replay modal ───────────────────────────────────────────────────

function addKvRow(container, key, val) {
  const row = document.createElement('div');
  row.className = 'kv-row';
  const kInput = document.createElement('input');
  kInput.className = 'kv-key';
  kInput.type = 'text';
  kInput.value = key;
  kInput.placeholder = 'Name';
  const vInput = document.createElement('input');
  vInput.className = 'kv-val';
  vInput.type = 'text';
  vInput.value = val;
  vInput.placeholder = 'Value';
  const del = document.createElement('button');
  del.className = 'kv-del';
  del.textContent = '×';
  del.title = 'Remove';
  del.onclick = () => row.remove();
  row.appendChild(kInput);
  row.appendChild(vInput);
  row.appendChild(del);
  container.appendChild(row);
}

function readKvTable(container) {
  const obj = {};
  for (const row of container.querySelectorAll('.kv-row')) {
    const k = row.querySelector('.kv-key').value.trim();
    const v = row.querySelector('.kv-val').value;
    if (k) obj[k] = v;
  }
  return obj;
}

function parseCookieHeader(cookieStr) {
  if (!cookieStr) return [];
  return cookieStr.split(';').map(p => {
    const idx = p.indexOf('=');
    if (idx < 0) return [p.trim(), ''];
    return [p.slice(0, idx).trim(), p.slice(idx + 1).trim()];
  }).filter(([n]) => n);
}

function readCookiesTable() {
  const pairs = [];
  const container = document.getElementById('replayCookiesTable');
  for (const row of container.querySelectorAll('.kv-row')) {
    const k = row.querySelector('.kv-key').value.trim();
    const v = row.querySelector('.kv-val').value.trim();
    if (k) pairs.push(`${k}=${v}`);
  }
  return pairs.join('; ');
}

function formatXml(xml) {
  let indent = 0;
  return xml
    .replace(/>\s*</g, '><')
    .replace(/(<[^/][^>]*[^/]>|<[^/][^>]*[^>]>)(?!<\/)/g, (m) => {
      const out = '  '.repeat(indent) + m;
      indent++;
      return out + '\n';
    })
    .replace(/<\/[^>]+>/g, (m) => {
      indent = Math.max(0, indent - 1);
      return '  '.repeat(indent) + m + '\n';
    })
    .replace(/(<[^>]+\/>)/g, (m) => '  '.repeat(indent) + m + '\n')
    .trim();
}

async function openReplay(evt) {
  let reqData = {};
  try { reqData = JSON.parse(evt.payload ?? '{}'); } catch {}
  const req = reqData.request ?? {};

  const method = req.method || 'GET';
  const url    = req.url    || '';
  const allHdrs = req.headers || {};

  const methodSel = document.getElementById('replayMethod');
  methodSel.value = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(method) ? method : 'GET';
  document.getElementById('replayUrl').value = url;
  document.getElementById('replayBody').value = req.postData || '';
  document.getElementById('replayResponse').innerHTML = '';
  document.getElementById('replaySpinner').classList.remove('visible');

  const hdrTable = document.getElementById('replayHeadersTable');
  const ckTable  = document.getElementById('replayCookiesTable');
  hdrTable.innerHTML = '';
  ckTable.innerHTML  = '';

  let cookieStr = '';
  for (const [k, v] of Object.entries(allHdrs)) {
    if (k.toLowerCase() === 'cookie') { cookieStr = v; continue; }
    addKvRow(hdrTable, k, v);
  }
  for (const [n, v] of parseCookieHeader(cookieStr)) {
    addKvRow(ckTable, n, v);
  }

  // Populate session cookie picker
  const sessionPick = document.getElementById('replayCookieSessionPick');
  sessionPick.innerHTML = '<option value="">Load from session…</option>';
  try {
    const sessions = await testerBrowser.sessions.list();
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sessionPick.appendChild(opt);
    }
  } catch {}
  let reqHost = '';
  try { reqHost = new URL(url.startsWith('http') ? url : 'https://' + url).hostname; } catch {}
  sessionPick.dataset.reqHost = reqHost;

  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('replayOverlay').classList.add('open');
  document.getElementById('replayUrl').focus();
}

function closeReplay() {
  document.getElementById('replayOverlay').classList.remove('open');
  testerBrowser.layout.setViewerVisible(true);
}

document.getElementById('replayAddHeader').onclick = () =>
  addKvRow(document.getElementById('replayHeadersTable'), '', '');
document.getElementById('replayAddCookie').onclick = () =>
  addKvRow(document.getElementById('replayCookiesTable'), '', '');

document.getElementById('replayCookieSessionPick').onchange = async (e) => {
  const id = e.target.value;
  if (!id) return;
  try {
    const reqHost = e.target.dataset.reqHost || '';
    const cookies = await testerBrowser.sessions.getCookies(id);
    const relevant = reqHost ? cookies.filter(c => cookieMatchesDomain(c, reqHost)) : cookies;
    const ckTable = document.getElementById('replayCookiesTable');
    ckTable.innerHTML = '';
    for (const c of relevant) addKvRow(ckTable, c.name, c.value);
  } catch {}
  e.target.value = '';
};

document.getElementById('replayFormatBody').onclick = () => {
  const ta = document.getElementById('replayBody');
  const raw = ta.value.trim();
  if (!raw) return;
  try {
    ta.value = JSON.stringify(JSON.parse(raw), null, 2);
    return;
  } catch {}
  try {
    ta.value = formatXml(raw);
  } catch {}
};

document.getElementById('closeReplayBtn').onclick = closeReplay;
document.getElementById('replayOverlay').onclick  = (e) => {
  if (e.target === document.getElementById('replayOverlay')) closeReplay();
};

document.getElementById('sendReplayBtn').onclick = async () => {
  const method  = document.getElementById('replayMethod').value;
  const url     = document.getElementById('replayUrl').value.trim();
  const body    = document.getElementById('replayBody').value;

  if (!url) return;

  const headers = readKvTable(document.getElementById('replayHeadersTable'));
  const cookieVal = readCookiesTable();
  if (cookieVal) headers['Cookie'] = cookieVal;

  const spinner = document.getElementById('replaySpinner');
  const resArea = document.getElementById('replayResponse');
  spinner.classList.add('visible');
  resArea.innerHTML = '';

  const result = await testerBrowser.recording.replay({ method, url, headers, body: body || undefined });
  spinner.classList.remove('visible');

  if (!result.ok) {
    resArea.innerHTML = `<div class="replay-res-status err">Error: ${escHtml(result.error || 'Unknown error')}</div>`;
    return;
  }

  const sc = result.status >= 200 && result.status < 300 ? 'ok' : 'err';
  const statusLine = document.createElement('div');
  statusLine.className   = `replay-res-status ${sc}`;
  statusLine.textContent = `${result.status} ${result.statusText}`;
  resArea.appendChild(statusLine);

  const hdrToggle = document.createElement('div');
  hdrToggle.className   = 'replay-res-hdr-toggle';
  hdrToggle.textContent = '▸ Response headers';
  const hdrRows = document.createElement('div');
  hdrRows.className = 'replay-res-hdr-rows';
  const tbl = document.createElement('table');
  tbl.className = 'replay-res-hdr-table';
  for (const [k, v] of Object.entries(result.headers || {})) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = k;
    const td2 = document.createElement('td'); td2.textContent = v;
    tr.appendChild(td1); tr.appendChild(td2); tbl.appendChild(tr);
  }
  hdrRows.appendChild(tbl);
  hdrToggle.onclick = () => {
    const open = hdrRows.classList.toggle('open');
    hdrToggle.textContent = (open ? '▾' : '▸') + ' Response headers';
  };
  resArea.appendChild(hdrToggle);
  resArea.appendChild(hdrRows);

  const bodyOut = document.createElement('pre');
  bodyOut.id = 'replayBodyOut';
  const ct = (result.headers['content-type'] || '').toLowerCase();
  if (ct.includes('json')) {
    try { bodyOut.textContent = JSON.stringify(JSON.parse(result.body), null, 2); }
    catch { bodyOut.textContent = result.body; }
  } else if (ct.includes('xml') || ct.includes('html')) {
    try { bodyOut.textContent = formatXml(result.body); }
    catch { bodyOut.textContent = result.body; }
  } else {
    bodyOut.textContent = result.body;
  }
  resArea.appendChild(bodyOut);
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
  const settings = await testerBrowser.settings.get();
  document.getElementById('redactHeadersToggle').checked = !!settings.redactSensitiveHeaders;
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

document.getElementById('redactHeadersToggle').addEventListener('change', (e) => {
  testerBrowser.settings.set({ redactSensitiveHeaders: e.target.checked });
});

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
  document.getElementById('consoleControls').style.display      = tab === 'console' ? '' : 'none';
  document.getElementById('storageControls').style.display      = tab === 'storage' ? 'flex' : 'none';
  document.getElementById('timelinePanelWrapper').style.display = tab === 'console' ? 'flex' : 'none';
  document.getElementById('storagePanel').style.display         = tab === 'storage' ? 'block' : 'none';
  const hasDetailTabs = detailTabs.length > 0;
  document.getElementById('detailPanel').classList.toggle('open', tab === 'console' && hasDetailTabs);
  document.getElementById('detailPanelResizeHandle').style.display = tab === 'console' && hasDetailTabs ? '' : 'none';
  if (tab === 'storage') loadStoragePanel();
}

document.getElementById('consoleTabConsole').addEventListener('click', () => switchConsoleTab('console'));
document.getElementById('consoleTabStorage').addEventListener('click', () => switchConsoleTab('storage'));
document.getElementById('refreshStorageBtn').addEventListener('click', loadStoragePanel);
document.getElementById('storageFilter').addEventListener('input', loadStoragePanel);
const domainFilterBtn = document.getElementById('domainFilterBtn');
domainFilterBtn.classList.add('active'); // matches domainFilterActive = true default
domainFilterBtn.addEventListener('click', () => {
  domainFilterActive = !domainFilterActive;
  domainFilterBtn.classList.toggle('active', domainFilterActive);
  loadStoragePanel();
});

// ── Storage panel ──────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

function cookieMatchesDomain(cookie, hostname) {
  if (!hostname) return true;
  const d = (cookie.domain || '').replace(/^\./, '');
  // Empty domain means a host-only cookie (common for IP addresses) — include it
  // since we cannot determine which host set it from the cookie data alone.
  if (!d) return true;
  return hostname === d || hostname.endsWith('.' + d);
}

async function copyToClipboard(text) {
  await testerBrowser.clipboard.write(text);
}

async function loadStoragePanel() {
  if (!activeId) return;
  const panel = document.getElementById('storagePanel');
  panel.innerHTML = '<div class="storage-empty">Loading…</div>';

  const filterText = document.getElementById('storageFilter').value.toLowerCase();
  const sessionId = activeId; // capture for async callbacks

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

  const filteredCookies = domainFilterActive
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
  cookieAddBtn.className = 'storage-add-btn';
  cookieAddBtn.textContent = '+ Add';
  cookieAddBtn.title = 'Add a new cookie';
  cookieHdr.appendChild(cookieAddBtn);
  if (cookies.length > 0) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'storage-clear-btn';
    clearBtn.textContent = 'Clear All';
    clearBtn.title = 'Delete all cookies for this session';
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
    domainInput.className = 'ls-edit-input';
    domainInput.placeholder = 'domain';
    domainInput.value = currentHostname || '';
    const nameInput = document.createElement('input');
    nameInput.className = 'ls-edit-input';
    nameInput.placeholder = 'name';
    const valInput = document.createElement('input');
    valInput.className = 'ls-edit-input';
    valInput.placeholder = 'value';
    const pathInput = document.createElement('input');
    pathInput.className = 'ls-edit-input';
    pathInput.placeholder = 'path';
    pathInput.value = '/';
    ['domain','name','value','path','','','','',''].forEach((field, i) => {
      const td = document.createElement('td');
      if (field === 'domain') td.appendChild(domainInput);
      else if (field === 'name') td.appendChild(nameInput);
      else if (field === 'value') td.appendChild(valInput);
      else if (field === 'path') td.appendChild(pathInput);
      addTr.appendChild(td);
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'storage-delete-btn';
    cancelBtn.textContent = '×';
    cancelBtn.title = 'Cancel';
    addTr.lastElementChild.appendChild(cancelBtn);
    cookieTbody.prepend(addTr);
    nameInput.focus();

    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      const name = nameInput.value.trim();
      if (!name) { loadStoragePanel(); return; }
      const domain = domainInput.value.trim() || currentHostname || 'localhost';
      const path = pathInput.value.trim() || '/';
      const url = `http://${domain.replace(/^\./, '')}${path}`;
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
      const isFirstParty = cookieMatchesDomain(c, currentHostname);
      const isRelevant3P = !isFirstParty && loadedDomains.some(d => cookieMatchesDomain(c, d));
      const isUnrelated3P = !isFirstParty && !isRelevant3P;

      const tr = document.createElement('tr');
      if (isUnrelated3P && currentHostname) tr.classList.add('cookie-row-irrelevant');

      const domainTd = document.createElement('td');
      domainTd.textContent = c.domain || '';
      if (isRelevant3P && currentHostname) {
        const badge = document.createElement('span');
        badge.className = 'cookie-3p relevant';
        badge.textContent = '3P';
        badge.title = 'Set by a resource loaded on this page';
        domainTd.appendChild(badge);
      } else if (isUnrelated3P && currentHostname) {
        const badge = document.createElement('span');
        badge.className = 'cookie-3p other';
        badge.textContent = '3P';
        badge.title = 'Set during a different navigation';
        domainTd.appendChild(badge);
      }
      tr.appendChild(domainTd);

      const nameTd = document.createElement('td');
      nameTd.textContent = c.name;
      tr.appendChild(nameTd);

      const valTd = document.createElement('td');
      valTd.className = 'copyable';
      valTd.style.cssText = 'max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      valTd.textContent = c.value;
      valTd.title = 'Click to copy · Double-click to edit';
      valTd.onclick = () => { copyToClipboard(c.value); flashCopied(valTd); };
      valTd.ondblclick = (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.className = 'ls-edit-input';
        input.value = c.value;
        valTd.innerHTML = '';
        valTd.style.overflow = 'visible';
        valTd.appendChild(input);
        input.focus(); input.select();
        let done = false;
        const commit = async () => {
          if (done) return; done = true;
          if (input.value !== c.value) {
            const host = (c.domain || '').replace(/^\./, '') || currentHostname || 'localhost';
            const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
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

      const pathTd = document.createElement('td');
      pathTd.textContent = c.path || '/';
      tr.appendChild(pathTd);

      const ssTd = document.createElement('td');
      ssTd.textContent = formatSameSite(c.sameSite);
      tr.appendChild(ssTd);

      const expTd = document.createElement('td');
      expTd.style.whiteSpace = 'nowrap';
      expTd.textContent = formatCookieExpiry(c.expirationDate);
      tr.appendChild(expTd);

      const secureTd = document.createElement('td');
      secureTd.innerHTML = `<span class="storage-badge ${c.secure ? 'yes' : 'no'}">${c.secure ? '✓' : '—'}</span>`;
      tr.appendChild(secureTd);

      const httpOnlyTd = document.createElement('td');
      httpOnlyTd.innerHTML = `<span class="storage-badge ${c.httpOnly ? 'yes' : 'no'}">${c.httpOnly ? '✓' : '—'}</span>`;
      tr.appendChild(httpOnlyTd);

      const delTd = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'storage-delete-btn';
      delBtn.textContent = '×';
      delBtn.title = 'Delete this cookie';
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
  const lsEntries = Object.entries(ls);
  const filteredLs = filterText
    ? lsEntries.filter(([k, v]) =>
        k.toLowerCase().includes(filterText) || v.toLowerCase().includes(filterText))
    : lsEntries;

  const lsHdr = document.createElement('div');
  lsHdr.className = 'storage-section-header';
  const lsTitle = document.createElement('span');
  lsTitle.className = 'storage-section-title';
  lsTitle.textContent = `Local Storage (${filteredLs.length}${filterText && filteredLs.length !== lsEntries.length ? '/' + lsEntries.length : ''})`;
  lsHdr.appendChild(lsTitle);
  const lsAddBtn = document.createElement('button');
  lsAddBtn.className = 'storage-add-btn';
  lsAddBtn.textContent = '+ Add';
  lsAddBtn.title = 'Add a new localStorage entry';
  lsHdr.appendChild(lsAddBtn);
  if (lsEntries.length > 0) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'storage-clear-btn';
    clearBtn.textContent = 'Clear All';
    clearBtn.title = 'Clear all localStorage for this page';
    clearBtn.onclick = async () => {
      await testerBrowser.sessions.clearLocalStorage(sessionId);
      loadStoragePanel();
    };
    lsHdr.appendChild(clearBtn);
  }
  panel.appendChild(lsHdr);

  const lsTable = document.createElement('table');
  lsTable.className = 'storage-table';
  lsTable.innerHTML = '<thead><tr><th style="width:35%">Key</th><th>Value</th><th></th></tr></thead>';
  const lsTbody = document.createElement('tbody');

  lsAddBtn.onclick = () => {
    if (lsTable.querySelector('.storage-add-row')) return;
    const addTr = document.createElement('tr');
    addTr.className = 'storage-add-row';
    const keyInput = document.createElement('input');
    keyInput.className = 'ls-edit-input';
    keyInput.placeholder = 'key';
    const valInput = document.createElement('input');
    valInput.className = 'ls-edit-input';
    valInput.placeholder = 'value';
    const keyTd = document.createElement('td'); keyTd.appendChild(keyInput); addTr.appendChild(keyTd);
    const valTd = document.createElement('td'); valTd.appendChild(valInput); addTr.appendChild(valTd);
    const cancelTd = document.createElement('td');
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'storage-delete-btn';
    cancelBtn.textContent = '×';
    cancelBtn.title = 'Cancel';
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
    empty.className = 'storage-empty';
    empty.textContent = filterText ? 'No entries match the filter' : 'No local storage entries for this page';
    panel.appendChild(empty);
  }
  for (const [k, v] of filteredLs) {
    const tr = document.createElement('tr');

    const keyTd = document.createElement('td');
    keyTd.textContent = k;
    keyTd.title = 'Double-click to rename key';
    keyTd.ondblclick = (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'ls-edit-input';
      input.value = k;
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
    valTd.className = 'copyable';
    valTd.style.cssText = 'max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    valTd.textContent = v;
    valTd.title = 'Click to copy · Double-click to edit';
    valTd.onclick = () => { copyToClipboard(v); flashCopied(valTd); };
    valTd.ondblclick = (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'ls-edit-input';
      input.value = v;
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

    const delTd = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'storage-delete-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Delete this entry';
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

// ── View dropdown ──────────────────────────────────────────────────────────

let consoleVisible = true;
const viewWrapper  = document.getElementById('viewWrapper');
const viewDropdown = document.getElementById('viewDropdown');

function updateViewDropdown() {
  document.getElementById('viewConsoleCheck').textContent   = consoleVisible      ? '✓' : '';
  document.getElementById('viewBookmarksCheck').textContent = bookmarksBarVisible ? '✓' : '';
}

function openViewDropdown() {
  if (viewDropdown.classList.contains('open')) return;
  viewDropdown.classList.add('open');
  updateViewDropdown();
  testerBrowser.layout.setViewerVisible(false);
}

function closeViewDropdown() {
  if (!viewDropdown.classList.contains('open')) return;
  viewDropdown.classList.remove('open');
  testerBrowser.layout.setViewerVisible(true);
}

document.getElementById('viewBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  viewDropdown.classList.contains('open') ? closeViewDropdown() : openViewDropdown();
});

document.addEventListener('click', (e) => {
  if (!viewWrapper.contains(e.target)) closeViewDropdown();
});

document.getElementById('viewToggleConsole').addEventListener('click', () => {
  consoleVisible = !consoleVisible;
  consolePanel.style.display = consoleVisible ? 'flex' : 'none';
  testerBrowser.layout.setConsoleHeight(consoleVisible ? consoleHeight : 0);
  updateViewDropdown();
  closeViewDropdown();
});

document.getElementById('viewToggleBookmarks').addEventListener('click', () => {
  toggleBookmarksBar();
  updateViewDropdown();
  closeViewDropdown();
});

// ── Boot ───────────────────────────────────────────────────────────────────

updateTopBarHeight();
testerBrowser.layout.setConsoleHeight(consoleHeight);
refreshTabs();
loadBookmarks();
loadUrlHistory();
pollTimeline();
