/* global testerBrowser */

const dlMap       = new Map();
let downloadsOpen = false;
const PANEL_WIDTH = 320; // must match #downloadsPanel's width in style.css

// #247: ids the downloads button's badge hasn't been "seen" for yet — a
// download the panel was never opened to look at, whether it's still
// progressing or has since completed while the panel stayed closed.
// Cleared whenever the panel actually opens.
const unseenIds = new Set();

function formatBytes(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function updateDownloadsBadge() {
  const badge = document.getElementById('downloadsBadge');
  badge.style.display = unseenIds.size > 0 ? 'flex' : 'none';
  badge.textContent   = unseenIds.size;
}

function markDownloadsSeen() {
  unseenIds.clear();
  updateDownloadsBadge();
}

async function renderDownloads() {
  const sorted = [...dlMap.values()].sort((a, b) => {
    if (a.state === 'progressing' && b.state !== 'progressing') return -1;
    if (b.state === 'progressing' && a.state !== 'progressing') return 1;
    return b.id < a.id ? 1 : -1;
  });

  const list = document.getElementById('downloadsList');
  if (sorted.length === 0) {
    list.innerHTML = '<div class="dl-empty">No downloads</div>';
    return;
  }

  // #247: which tab each download came from — resolved by sessionId against
  // the current session list, since a tab can be renamed, re-colored or
  // closed after the fact.
  let sessions = [];
  try { sessions = await testerBrowser.sessions.list(); } catch { /* show "(closed tab)" for all */ }
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  list.innerHTML = '';
  for (const dl of sorted) {
    const item = document.createElement('div');
    item.className = 'dl-item';

    const name = document.createElement('div');
    name.className   = 'dl-name';
    name.textContent = dl.filename;
    name.title       = dl.url;
    item.appendChild(name);

    const s = sessionById.get(dl.sessionId);
    const tab = document.createElement('div');
    tab.className = 'dl-tab';
    const swatch = document.createElement('span');
    swatch.className = 'dl-tab-swatch';
    swatch.style.background = s?.color || 'transparent';
    tab.appendChild(swatch);
    const tabName = document.createElement('span');
    tabName.textContent = s?.name || '(closed tab)';
    tab.appendChild(tabName);
    item.appendChild(tab);

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
  // The WebContentsView paints on top of window HTML regardless of z-index, so the
  // panel (docked to the right edge) needs the view's width narrowed to stay visible.
  testerBrowser.layout.setRightPanelWidth(downloadsOpen ? PANEL_WIDTH : 0);
  if (downloadsOpen) {
    renderDownloads();
    markDownloadsSeen();
  }
}

export function initDownloads() {
  testerBrowser.downloads.onUpdate(async (dl) => {
    dlMap.set(dl.id, dl);
    if (!downloadsOpen) unseenIds.add(dl.id);
    updateDownloadsBadge();
    if (downloadsOpen) { renderDownloads(); return; }

    // #247: off by default — a download triggered incidentally by a page
    // under test no longer force-opens the panel and narrows the active
    // page mid-test. The badge above is how a tester notices it instead.
    const settings = await testerBrowser.settings.get().catch(() => ({}));
    if (settings.autoOpenDownloadsPanel && dl.state === 'progressing' && !downloadsOpen) toggleDownloads();
  });

  testerBrowser.downloads.onCleared(() => {
    for (const [id, dl] of dlMap) if (dl.state !== 'progressing') { dlMap.delete(id); unseenIds.delete(id); }
    updateDownloadsBadge();
    if (downloadsOpen) renderDownloads();
  });

  document.getElementById('downloadsBtn').onclick = () => toggleDownloads();
  document.getElementById('closeDownloadsBtn').onclick = () => {
    downloadsOpen = false;
    document.getElementById('downloadsPanel').classList.remove('open');
    testerBrowser.layout.setRightPanelWidth(0);
  };
  document.getElementById('clearDownloadsBtn').onclick = () => testerBrowser.downloads.clear();
}
