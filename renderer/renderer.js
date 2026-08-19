/* global testerBrowser */

let activeId = null;
let lastTs = 0;
let sessionCounter = 0;
let mruStack = []; // most-recently-used first

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

async function refreshTabs() {
  const sessions = await testerBrowser.sessions.list();
  const tabsEl = document.getElementById('tabs');
  tabsEl.querySelectorAll('.tab').forEach((el) => el.remove());
  for (const s of sessions) {
    const tab = document.createElement('span');
    tab.className = 'tab' + (s.id === activeId ? ' active' : '');
    tab.textContent = s.name;
    tab.onclick = () => switchToSession(s.id);
    tabsEl.insertBefore(tab, document.getElementById('newSessionBtn'));
  }
  if (!activeId && sessions.length) {
    activeId = sessions[0].id;
    recordVisit(activeId);
  }
}

document.getElementById('newSessionBtn').onclick = async () => {
  sessionCounter++;
  const id = await testerBrowser.sessions.create(`Session ${sessionCounter}`, { persistent: false });
  await switchToSession(id);
};

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
  checking:      { cls: 'info', text: 'Checking for updates…' },
  available:     { cls: 'info', text: (v) => `Update ${v} found — downloading…` },
  downloading:   { cls: 'info', text: 'Downloading update…' },
  downloaded:    { cls: 'warn', text: (v) => `Update ${v} downloaded — restart to install` },
  'not-available': { cls: 'ok', text: 'You\'re up to date' },
  error:         { cls: 'err', text: (msg) => `Update error: ${msg || 'unknown'}` },
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
  document.getElementById('settingsOverlay').classList.add('open');
  const info = await testerBrowser.app.getVersionInfo();
  applyUpdateStatus(info);
}

function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('open');
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

document.getElementById('restartBtn').onclick = () => {
  testerBrowser.app.restartAndInstall();
};

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
