/* global testerBrowser */
import { escHtml, wirePillGroup, activePillValues, matchesFreeText } from './utils.js';
import { populateSessionPickers } from './session-picker.js';

let lastDiffRows = [];
let cachedSessions = [];
let rawMapA = new Map();
let rawMapB = new Map();
let groupDuplicates = true;
// Session names must be captured at compare time, not looked up later by id:
// destroySession removes a closed session from sessions.list() entirely, so
// a later re-lookup would silently fail once a compared session is closed.
let diffMeta = null;

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
      <label class="diff-label diff-group-toggle">
        <input type="checkbox" id="diffGroupToggle" checked /> Group duplicates
      </label>
      <div class="filter-pills" id="diffCatPills">
        <button class="filter-pill on" data-cat="diff"    title="Different">Different</button>
        <button class="filter-pill on" data-cat="only-a"  title="Only in A">Only A</button>
        <button class="filter-pill on" data-cat="only-b"  title="Only in B">Only B</button>
        <button class="filter-pill on" data-cat="same"    title="Identical">Same</button>
      </div>
      <input type="text" class="diff-filter-text" id="diffFilterText"
        placeholder="Filter URLs, e.g. api -analytics" />
      <button class="diff-har-btn" id="diffHarBtn" disabled>Export HAR</button>
      <button class="console-icon-btn" id="diffResetBtn" title="Reset comparison">&#10005;</button>
    </div>
    <div class="diff-body" id="diffBody">
      <div class="diff-hint">Select two sessions above and click Compare.</div>
    </div>`;

  populatePickers();

  document.getElementById('diffRunBtn').addEventListener('click', runDiff);
  document.getElementById('diffHarBtn').addEventListener('click', exportDiffHar);
  document.getElementById('diffGroupToggle').addEventListener('change', onGroupToggleChanged);
  document.getElementById('diffResetBtn').addEventListener('click', resetDiff);
  document.getElementById('diffFilterText').addEventListener('input', () => {
    if (lastDiffRows.length > 0) renderDiffTable(document.getElementById('diffBody'));
  });
  wirePillGroup(document.getElementById('diffCatPills'), () => {
    if (lastDiffRows.length > 0) renderDiffTable(document.getElementById('diffBody'));
  });
}

function resetDiff() {
  rawMapA = new Map();
  rawMapB = new Map();
  lastDiffRows = [];
  diffMeta = null;
  document.getElementById('diffFilterText').value = '';
  document.getElementById('diffBody').innerHTML = '<div class="diff-hint">Select two sessions above and click Compare.</div>';
  document.getElementById('diffHarBtn').disabled = true;
}

function onGroupToggleChanged(e) {
  groupDuplicates = e.target.checked;
  if (rawMapA.size === 0 && rawMapB.size === 0) return;
  computeDiffRows();
  renderDiffTable(document.getElementById('diffBody'));
}

export async function refreshDiffPickers() {
  const pickA = document.getElementById('diffPickA');
  if (!pickA) return; // diff panel not yet initialised
  await populatePickers();
}

async function populatePickers() {
  cachedSessions = await populateSessionPickers('diffPickA', 'diffPickB');
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

  const nameA = cachedSessions.find(s => s.id === idA)?.name ?? idA;
  const nameB = cachedSessions.find(s => s.id === idB)?.name ?? idB;
  diffMeta = { nameA, nameB, comparedAt: Date.now() };

  const [evA, evB] = await Promise.all([
    testerBrowser.recording.timeline(idA, { limit: 5000 }),
    testerBrowser.recording.timeline(idB, { limit: 5000 }),
  ]);

  rawMapA = buildRequestMap(evA);
  rawMapB = buildRequestMap(evB);

  computeDiffRows();
  renderDiffTable(body);
  harBtn.disabled = lastDiffRows.length === 0;
}

// Groups every call to the same "METHOD url" within one session, so a page
// that fires the same request more than once (analytics beacons, polling,
// cache revalidation) doesn't drown out genuine differences between sessions.
function buildRequestMap(events) {
  const reqMeta = new Map();
  const result  = new Map();

  const pushCall = (key, method, url, status, fromCache) => {
    let entry = result.get(key);
    if (!entry) {
      entry = { method, url, calls: [] };
      result.set(key, entry);
    }
    entry.calls.push({ status, fromCache });
  };

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
        const fromCache = !!(p.response.fromDiskCache || p.response.fromServiceWorker);
        pushCall(key, meta.method, meta.url, p.response.status, fromCache);
      } catch {}
    }
    if (ev.kind === 'network-failed') {
      try {
        const p = JSON.parse(ev.payload);
        const meta = reqMeta.get(p.requestId);
        if (!meta) continue;
        const key = `${meta.method} ${meta.url}`;
        pushCall(key, meta.method, meta.url, 'FAILED', false);
      } catch {}
    }
  }

  return result;
}

// Builds lastDiffRows from rawMapA/rawMapB according to the current
// groupDuplicates mode, without re-fetching the timelines.
function computeDiffRows() {
  const allKeys = new Set([...rawMapA.keys(), ...rawMapB.keys()]);
  lastDiffRows = [];

  for (const key of allKeys) {
    const a = rawMapA.get(key);
    const b = rawMapB.get(key);

    if (groupDuplicates) {
      lastDiffRows.push(makeGroupedRow(key, a, b));
    } else {
      const maxLen = Math.max(a?.calls.length ?? 0, b?.calls.length ?? 0);
      for (let i = 0; i < maxLen; i++) {
        lastDiffRows.push(makeCallRow(key, a, b, i));
      }
    }
  }

  lastDiffRows.sort((x, y) => {
    const order = { diff: 0, 'only-a': 1, 'only-b': 2, same: 3 };
    return (order[x.category] ?? 9) - (order[y.category] ?? 9) || x.key.localeCompare(y.key);
  });
}

function summarizeCalls(entry) {
  if (!entry || entry.calls.length === 0) return null;
  const statuses = [...new Set(entry.calls.map(c => c.status))];
  const cacheCount = entry.calls.filter(c => c.fromCache).length;
  const cache = cacheCount === 0 ? 'none' : cacheCount === entry.calls.length ? 'all' : 'mixed';
  return { label: statuses.join('/'), count: entry.calls.length, cache };
}

function makeGroupedRow(key, a, b) {
  const sa = summarizeCalls(a);
  const sb = summarizeCalls(b);
  let category;
  if (sa && !sb)          category = 'only-a';
  else if (!sa && sb)     category = 'only-b';
  else if (sa.label === sb.label) category = 'same';
  else                    category = 'diff';
  return {
    key,
    method: (a ?? b).method,
    url: (a ?? b).url,
    a: sa,
    b: sb,
    category,
  };
}

function makeCallRow(key, a, b, index) {
  const callA = a?.calls[index];
  const callB = b?.calls[index];
  const cellA = callA ? { label: String(callA.status), count: 1, cache: callA.fromCache ? 'all' : 'none' } : null;
  const cellB = callB ? { label: String(callB.status), count: 1, cache: callB.fromCache ? 'all' : 'none' } : null;
  let category;
  if (cellA && !cellB)          category = 'only-a';
  else if (!cellA && cellB)     category = 'only-b';
  else if (cellA.label === cellB.label) category = 'same';
  else                          category = 'diff';
  return {
    key: `${key}#${index}`,
    method: (a ?? b).method,
    url: (a ?? b).url,
    a: cellA,
    b: cellB,
    category,
  };
}

function renderDiffTable(body) {
  if (lastDiffRows.length === 0) {
    body.innerHTML = '<div class="diff-hint">No network requests found in either session.</div>';
    return;
  }

  const meta = diffMeta ? `<div class="diff-meta">Compared <b>${escHtml(diffMeta.nameA)}</b> vs ` +
    `<b>${escHtml(diffMeta.nameB)}</b> at ${new Date(diffMeta.comparedAt).toLocaleTimeString()}</div>` : '';

  // Legend counts always reflect the full comparison, independent of the
  // category pills below — those only control which rows the table shows.
  const counts = { same: 0, 'only-a': 0, 'only-b': 0, diff: 0 };
  for (const r of lastDiffRows) counts[r.category] = (counts[r.category] || 0) + 1;

  const legend = `<div class="diff-legend">
    <span class="diff-badge same">same ${counts.same}</span>
    <span class="diff-badge diff">different ${counts.diff}</span>
    <span class="diff-badge only-a">only A ${counts['only-a']}</span>
    <span class="diff-badge only-b">only B ${counts['only-b']}</span>
  </div>`;

  const activeCats = activePillValues(document.getElementById('diffCatPills'), 'cat');
  const filterText = document.getElementById('diffFilterText').value;
  const rows = lastDiffRows.filter(r => activeCats.has(r.category) && matchesFreeText(r.url, filterText)).map(r => {
    const url = escHtml(r.url);
    const method = escHtml(r.method);
    return `<tr class="diff-row ${r.category}">
      <td class="diff-method">${method}</td>
      <td class="diff-url" title="${url}">${url}</td>
      <td class="diff-st">${renderCell(r.a)}</td>
      <td class="diff-st">${renderCell(r.b)}</td>
    </tr>`;
  }).join('');

  body.innerHTML = meta + legend + `<div class="diff-table-wrap"><table class="diff-table">
    <thead><tr><th>Method</th><th>URL</th><th>Status A</th><th>Status B</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderCell(cell) {
  if (!cell) return '<span class="diff-status diff-absent">—</span>';
  const count = cell.count > 1 ? `<span class="diff-count" title="${cell.count} calls">×${cell.count}</span>` : '';
  const cache = cell.cache !== 'none'
    ? `<span class="diff-cache ${cell.cache}" title="${cell.cache === 'all' ? 'served from cache' : 'some calls served from cache'}">cache${cell.cache === 'mixed' ? '*' : ''}</span>`
    : '';
  return `<span class="diff-status">${escHtml(cell.label)}</span>${count}${cache}`;
}

function exportDiffHar() {
  const entries = lastDiffRows.map(r => ({
    category: r.category,
    method:   r.method,
    url:      r.url,
    statusA:  r.a?.label ?? null,
    countA:   r.a?.count ?? 0,
    cacheA:   r.a?.cache ?? 'none',
    statusB:  r.b?.label ?? null,
    countB:   r.b?.count ?? 0,
    cacheB:   r.b?.cache ?? 'none',
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

