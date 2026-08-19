/* global testerBrowser */

let activeId = null;
let lastTs = 0;
let sessionCounter = 0;
let mruStack = []; // most-recently-used first
let tabClickTimer = null; // delays single-click so dblclick can cancel it
let tabOrder = []; // explicit display order; new tabs splice in after the active tab
let dragSourceId = null;

function insertAfterActive(id) {
  const idx = activeId ? tabOrder.indexOf(activeId) : -1;
  if (idx === -1) tabOrder.push(id);
  else tabOrder.splice(idx + 1, 0, id);
}

// --- Console resize ---

const CONSOLE_DEFAULT = 220;
let consoleHeight = CONSOLE_DEFAULT;
const consolePanel = document.getElementById('consolePanel');
const consoleDragHandle = document.getElementById('consoleDragHandle');

function setConsoleHeight(h) {
  consoleHeight = Math.max(80, Math.min(h, window.innerHeight - 120));
  consolePanel.style.height = consoleHeight + 'px';
  testerBrowser.layout.setConsoleHeight(consoleHeight);
}

consoleDragHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startH = consoleHeight;
  consoleDragHandle.classList.add('dragging');

  const onMove = (ev) => setConsoleHeight(startH + (startY - ev.clientY));
  const onUp = () => {
    consoleDragHandle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// --- Tab MRU ---

function recordVisit(id) {
  mruStack = [id, ...mruStack.filter((x) => x !== id)];
}

async function switchToSession(id) {
  activeId = id;
  lastTs = 0;
  document.getElementById('timelinePanel').innerHTML = '';
  recordVisit(id);
  await testerBrowser.sessions.switchTo(id);
  refreshTabs();
}

function cycleTab(reverse) {
  if (mruStack.length < 2) return;
  const targetId = reverse ? mruStack[mruStack.length - 1] : mruStack[1];
  switchToSession(targetId);
}

// --- Tabs ---

async function refreshTabs() {
  const sessions = await testerBrowser.sessions.list();
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));

  // Keep tabOrder in sync: remove closed tabs, append any unknown new ones at the end
  tabOrder = tabOrder.filter((id) => sessionMap.has(id));
  for (const s of sessions) {
    if (!tabOrder.includes(s.id)) tabOrder.push(s.id);
  }

  const tabsEl = document.getElementById('tabs');
  tabsEl.querySelectorAll('.tab').forEach((el) => el.remove());

  for (const id of tabOrder) {
    const s = sessionMap.get(id);
    const tab = document.createElement('span');
    tab.className = 'tab' + (s.id === activeId ? ' active' : '');
    tab.dataset.id = s.id;

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = s.name;
    name.onclick = () => {
      clearTimeout(tabClickTimer);
      tabClickTimer = setTimeout(() => switchToSession(s.id), 250);
    };
    name.ondblclick = (e) => {
      e.stopPropagation();
      clearTimeout(tabClickTimer); // cancel the pending switchToSession
      startRename(s.id, name);
    };

    const closeBtn = document.createElement('span');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close tab';
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      closeTab(s.id);
    };

    // --- Drag to reorder ---
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
      const midX = tab.getBoundingClientRect().left + tab.offsetWidth / 2;
      tab.classList.toggle('drag-left',  e.clientX <= midX);
      tab.classList.toggle('drag-right', e.clientX >  midX);
    });
    tab.addEventListener('dragleave', () => {
      tab.classList.remove('drag-left', 'drag-right');
    });
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drag-left', 'drag-right');
      if (!dragSourceId || dragSourceId === s.id) return;
      const insertBefore = e.clientX <= tab.getBoundingClientRect().left + tab.offsetWidth / 2;
      tabOrder = tabOrder.filter((x) => x !== dragSourceId);
      const toIdx = tabOrder.indexOf(s.id);
      tabOrder.splice(insertBefore ? toIdx : toIdx + 1, 0, dragSourceId);
      refreshTabs();
    });

    tab.appendChild(name);
    tab.appendChild(closeBtn);
    tabsEl.insertBefore(tab, document.getElementById('newSessionBtn'));
  }

  // Remove from MRU any destroyed session ids
  const ids = new Set(sessions.map((s) => s.id));
  mruStack = mruStack.filter((id) => ids.has(id));

  if (!activeId && sessions.length) {
    activeId = sessions[0].id;
    recordVisit(activeId);
  }
}

function startRename(id, nameEl) {
  const original = nameEl.textContent;
  const input = document.createElement('input');
  input.className = 'tab-rename-input';
  input.value = original;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const newName = input.value.trim() || original;
    await testerBrowser.sessions.rename(id, newName);
    refreshTabs();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    input.replaceWith(nameEl);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { cancel(); }
  });
  input.addEventListener('blur', commit);
}

async function closeTab(id) {
  await testerBrowser.sessions.destroy(id);
  tabOrder = tabOrder.filter((x) => x !== id);
  mruStack = mruStack.filter((x) => x !== id);

  if (activeId === id) {
    // Switch to most-recently-used surviving tab
    const next = mruStack[0] ?? null;
    activeId = null;
    if (next) {
      await switchToSession(next);
      return; // switchToSession calls refreshTabs
    }
  }
  refreshTabs();
}

document.getElementById('newSessionBtn').onclick = async () => {
  sessionCounter++;
  const id = await testerBrowser.sessions.create(`Session ${sessionCounter}`, { persistent: false });
  insertAfterActive(id);
  await switchToSession(id);
};

// --- URL bar ---

document.getElementById('urlbar').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && activeId) {
    await testerBrowser.sessions.navigate(activeId, e.target.value);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    cycleTab(e.shiftKey);
  }
});

testerBrowser.sessions.onNavigated(({ id, url }) => {
  if (id === activeId) document.getElementById('urlbar').value = url;
});

testerBrowser.sessions.onTabCycle(({ reverse }) => cycleTab(reverse));
testerBrowser.sessions.onNewTab(({ id }) => { insertAfterActive(id); switchToSession(id); });

// --- Export HAR ---

document.getElementById('exportHarBtn').onclick = async () => {
  if (!activeId) return;
  const har = await testerBrowser.recording.exportHAR(activeId);
  const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${activeId}.har.json`;
  a.click();
};

// --- Settings modal ---

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
  document.getElementById('latestVersion').textContent = latest || (status === 'not-available' ? current : '—');
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.checking;
  const el = document.getElementById('updateStatusText');
  el.className = cfg.cls;
  el.textContent = typeof cfg.text === 'function' ? cfg.text(latest) : cfg.text;
  document.getElementById('restartBtn').style.display = status === 'downloaded' ? '' : 'none';
}

async function openSettings() {
  await testerBrowser.layout.setViewerVisible(false); // hide BrowserView so overlay is fully visible
  document.getElementById('settingsOverlay').classList.add('open');
  const info = await testerBrowser.app.getVersionInfo();
  applyUpdateStatus(info);
}

function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('open');
  testerBrowser.layout.setViewerVisible(true);
}

document.getElementById('closeSettingsBtn').onclick = closeSettings;
document.getElementById('settingsOverlay').onclick = (e) => {
  if (e.target === document.getElementById('settingsOverlay')) closeSettings();
};
document.getElementById('checkUpdatesBtn').onclick = async () => {
  document.getElementById('updateStatusText').className = 'info';
  document.getElementById('updateStatusText').textContent = 'Checking for updates…';
  document.getElementById('latestVersion').textContent = '—';
  await testerBrowser.app.checkForUpdates();
};
document.getElementById('restartBtn').onclick = () => testerBrowser.app.restartAndInstall();

testerBrowser.app.onShowSettings(() => openSettings());
testerBrowser.app.onUpdateStatus((data) => applyUpdateStatus(data));

// --- Timeline polling ---

async function pollTimeline() {
  if (activeId) {
    const events = await testerBrowser.recording.timeline(activeId, { since: lastTs || undefined, limit: 200 });
    const panel = document.getElementById('timelinePanel');
    for (const e of events) {
      const line = document.createElement('div');
      line.className = `evt ${e.kind}`;
      const time = new Date(e.ts).toLocaleTimeString();
      line.textContent = `[${time}] ${e.summary}`;
      panel.appendChild(line);
      lastTs = Math.max(lastTs, e.ts);
    }
    if (events.length) panel.scrollTop = panel.scrollHeight;
  }
  setTimeout(pollTimeline, 1000);
}

refreshTabs();
pollTimeline();
