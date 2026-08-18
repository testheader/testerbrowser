/* global testerBrowser */

let activeId = null;
let lastTs = 0;

async function refreshTabs() {
  const sessions = await testerBrowser.sessions.list();
  const tabsEl = document.getElementById('tabs');
  tabsEl.querySelectorAll('.tab').forEach((el) => el.remove());
  for (const s of sessions) {
    const tab = document.createElement('span');
    tab.className = 'tab' + (s.id === activeId ? ' active' : '');
    tab.textContent = s.name;
    tab.onclick = async () => {
      activeId = s.id;
      lastTs = 0;
      document.getElementById('timelinePanel').innerHTML = '';
      await testerBrowser.sessions.switchTo(s.id);
      refreshTabs();
    };
    tabsEl.insertBefore(tab, document.getElementById('newSessionBtn'));
  }
  if (!activeId && sessions.length) activeId = sessions[0].id;
}

document.getElementById('newSessionBtn').onclick = async () => {
  const name = prompt('Session name:', `Session ${Date.now() % 1000}`);
  if (!name) return;
  const id = await testerBrowser.sessions.create(name, { persistent: false });
  activeId = id;
  await testerBrowser.sessions.switchTo(id);
  refreshTabs();
};

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
