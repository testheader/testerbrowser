/* global testerBrowser */

let lastDiffRows = [];
let cachedSessions = [];

export function initDiff() {
  const panel = document.getElementById('diffPanel');
  if (panel.dataset.initialized) return;
  panel.dataset.initialized = '1';

  panel.innerHTML = `
    <div class="diff-toolbar">
      <label class="diff-label">Session A
        <select class="diff-pick" id="diffPickA"></select>
      </label>
      <label class="diff-label">Session B
        <select class="diff-pick" id="diffPickB"></select>
      </label>
      <button class="diff-run-btn" id="diffRunBtn">Compare</button>
      <button class="diff-har-btn" id="diffHarBtn" disabled>Export HAR</button>
    </div>
    <div class="diff-body" id="diffBody">
      <div class="diff-hint">Select two sessions above and click Compare.</div>
    </div>`;

  populatePickers();

  document.getElementById('diffRunBtn').addEventListener('click', runDiff);
  document.getElementById('diffHarBtn').addEventListener('click', exportDiffHar);
}

export async function refreshDiffPickers() {
  const pickA = document.getElementById('diffPickA');
  if (!pickA) return; // diff panel not yet initialised
  await populatePickers();
}

async function populatePickers() {
  cachedSessions = await testerBrowser.sessions.list();
  const pickA = document.getElementById('diffPickA');
  const pickB = document.getElementById('diffPickB');
  if (!pickA || !pickB) return;

  const prevA = pickA.value;
  const prevB = pickB.value;

  buildPickerOptions(pickA, cachedSessions, prevB);
  buildPickerOptions(pickB, cachedSessions, prevA);

  // Restore previous selections if still valid; otherwise default to first two
  const validIds = new Set(cachedSessions.map(s => s.id));
  if (prevA && validIds.has(prevA) && prevA !== pickB.value) {
    pickA.value = prevA;
  } else if (!pickA.value && cachedSessions.length >= 1) {
    pickA.value = cachedSessions[0].id;
  }
  if (prevB && validIds.has(prevB) && prevB !== pickA.value) {
    pickB.value = prevB;
  } else if (!pickB.value && cachedSessions.length >= 2) {
    pickB.value = cachedSessions[1].id;
  }

  pickA.onchange = () => {
    buildPickerOptions(pickB, cachedSessions, pickA.value);
    if (pickB.value === pickA.value) pickB.value = '';
  };
  pickB.onchange = () => {
    buildPickerOptions(pickA, cachedSessions, pickB.value);
    if (pickA.value === pickB.value) pickA.value = '';
  };
}

function buildPickerOptions(select, sessions, excludeId) {
  const current = select.value;
  const opts = sessions
    .filter(s => s.id !== excludeId)
    .map(s => `<option value="${s.id}">${escHtml(s.name)}</option>`)
    .join('');
  select.innerHTML = '<option value="">— pick session —</option>' + opts;
  // Restore selection if still present after filter
  if (current && current !== excludeId) select.value = current;
}

async function runDiff() {
  const idA = document.getElementById('diffPickA')?.value;
  const idB = document.getElementById('diffPickB')?.value;
  const body = document.getElementById('diffBody');
  const harBtn = document.getElementById('diffHarBtn');
  if (!idA || !idB) { body.innerHTML = '<div class="diff-hint">Select both sessions first.</div>'; return; }
  if (idA === idB) { body.innerHTML = '<div class="diff-hint">Pick two different sessions.</div>'; return; }

  body.innerHTML = '<div class="diff-hint">Loading…</div>';
  harBtn.disabled = true;

  const [evA, evB] = await Promise.all([
    testerBrowser.recording.timeline(idA, { limit: 5000 }),
    testerBrowser.recording.timeline(idB, { limit: 5000 }),
  ]);

  const mapA = buildRequestMap(evA);
  const mapB = buildRequestMap(evB);

  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
  lastDiffRows = [];

  for (const key of allKeys) {
    const a = mapA.get(key);
    const b = mapB.get(key);
    let category;
    if (a && !b)      category = 'only-a';
    else if (!a && b) category = 'only-b';
    else if (a.status === b.status) category = 'same';
    else              category = 'diff';
    lastDiffRows.push({ key, a, b, category });
  }

  lastDiffRows.sort((x, y) => {
    const order = { diff: 0, 'only-a': 1, 'only-b': 2, same: 3 };
    return (order[x.category] ?? 9) - (order[y.category] ?? 9) || x.key.localeCompare(y.key);
  });

  renderDiffTable(body);
  harBtn.disabled = lastDiffRows.length === 0;
}

function buildRequestMap(events) {
  const reqMeta = new Map();
  const result  = new Map();

  for (const ev of events) {
    if (ev.kind === 'network-request') {
      try {
        const p = JSON.parse(ev.payload);
        reqMeta.set(p.requestId, { method: p.request.method, url: p.request.url });
      } catch {}
    }
    if (ev.kind === 'network-response') {
      try {
        const p = JSON.parse(ev.payload);
        const meta = reqMeta.get(p.requestId);
        if (!meta) continue;
        const key = `${meta.method} ${meta.url}`;
        result.set(key, { method: meta.method, url: meta.url, status: p.response.status });
      } catch {}
    }
    if (ev.kind === 'network-failed') {
      try {
        const p = JSON.parse(ev.payload);
        const meta = reqMeta.get(p.requestId);
        if (!meta) continue;
        const key = `${meta.method} ${meta.url}`;
        if (!result.has(key)) result.set(key, { method: meta.method, url: meta.url, status: 'FAILED' });
      } catch {}
    }
  }

  return result;
}

function renderDiffTable(body) {
  if (lastDiffRows.length === 0) {
    body.innerHTML = '<div class="diff-hint">No network requests found in either session.</div>';
    return;
  }

  const counts = { same: 0, 'only-a': 0, 'only-b': 0, diff: 0 };
  for (const r of lastDiffRows) counts[r.category] = (counts[r.category] || 0) + 1;

  const legend = `<div class="diff-legend">
    <span class="diff-badge same">same ${counts.same}</span>
    <span class="diff-badge diff">different ${counts.diff}</span>
    <span class="diff-badge only-a">only A ${counts['only-a']}</span>
    <span class="diff-badge only-b">only B ${counts['only-b']}</span>
  </div>`;

  const rows = lastDiffRows.map(r => {
    const url = escHtml(r.url ?? r.key.replace(/^\S+ /, ''));
    const method = escHtml(r.method ?? r.key.split(' ')[0]);
    const stA = r.a ? `<span class="diff-status">${r.a.status}</span>` : '<span class="diff-status diff-absent">—</span>';
    const stB = r.b ? `<span class="diff-status">${r.b.status}</span>` : '<span class="diff-status diff-absent">—</span>';
    return `<tr class="diff-row ${r.category}">
      <td class="diff-method">${method}</td>
      <td class="diff-url" title="${url}">${url}</td>
      <td class="diff-st">${stA}</td>
      <td class="diff-st">${stB}</td>
    </tr>`;
  }).join('');

  body.innerHTML = legend + `<div class="diff-table-wrap"><table class="diff-table">
    <thead><tr><th>Method</th><th>URL</th><th>Status A</th><th>Status B</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function exportDiffHar() {
  const entries = lastDiffRows.map(r => ({
    category: r.category,
    method:   r.method ?? r.key.split(' ')[0],
    url:      r.url ?? r.key.replace(/^\S+ /, ''),
    statusA:  r.a?.status ?? null,
    statusB:  r.b?.status ?? null,
  }));
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'TesterBrowser', version: 'diff' },
      comment: 'Environment diff export',
      entries,
    },
  };
  const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'session-diff.har';
  a.click();
  URL.revokeObjectURL(url);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
