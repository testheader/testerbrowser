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

// Ctrl+Tab when the top bar (renderer) has focus
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    cycleTab(e.shiftKey);
  }
});

testerBrowser.sessions.onNavigated(({ id, url }) => {
  if (id === activeId) {
    document.getElementById('urlbar').value = url;
  }
});

// Ctrl+Tab when a BrowserView has focus (intercepted in main via before-input-event)
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
