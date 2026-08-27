/* global testerBrowser */

const dlMap       = new Map();
let downloadsOpen = false;

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

export function initDownloads() {
  testerBrowser.downloads.onUpdate((dl) => {
    dlMap.set(dl.id, dl);
    updateDownloadsBadge();
    if (downloadsOpen) renderDownloads();
    if (dl.state === 'progressing' && !downloadsOpen) toggleDownloads();
  });

  testerBrowser.downloads.onCleared(() => {
    for (const [id, dl] of dlMap) if (dl.state !== 'progressing') dlMap.delete(id);
    updateDownloadsBadge();
    if (downloadsOpen) renderDownloads();
  });

  document.getElementById('downloadsBtn').onclick = () => toggleDownloads();
  document.getElementById('closeDownloadsBtn').onclick = () => {
    downloadsOpen = false;
    document.getElementById('downloadsPanel').classList.remove('open');
  };
  document.getElementById('clearDownloadsBtn').onclick = () => testerBrowser.downloads.clear();
}
