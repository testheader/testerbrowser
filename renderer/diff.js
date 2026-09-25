/* global testerBrowser */
import { escHtml, wirePillGroup, activePillValues, matchesFreeText } from './utils.js';
import { populateSessionPickers } from './session-picker.js';
import {
  DEFAULT_IGNORED_PARAMS, DEFAULT_IGNORED_HEADERS,
  buildRequestMap, computeDiffRows, isTruncated,
} from './diff-logic.js';

const RECORDING_FETCH_LIMIT = 5000;
const IGNORE_PARAMS_LS_KEY = 'diffIgnoreParams';

let lastDiffRows = [];
let cachedSessions = [];
// Raw events from the last Compare — kept so switching Match mode or
// editing the ignore-params list can recompute without re-fetching.
let rawEventsA = [];
let rawEventsB = [];
let rawMapA = new Map();
let rawMapB = new Map();
let groupDuplicates = true;
let matchMode = 'full'; // 'full' | 'path'
let ignoreParams = loadIgnoreParams();
let truncatedSides = []; // subset of ['A', 'B']
let expandedKeys = new Set();
// Session names must be captured at compare time, not looked up later by id:
// destroySession removes a closed session from sessions.list() entirely, so
// a later re-lookup would silently fail once a compared session is closed.
let diffMeta = null;

function loadIgnoreParams() {
  try {
    const raw = localStorage.getItem(IGNORE_PARAMS_LS_KEY);
    if (raw && raw.trim()) return raw.split(',').map(s => s.trim()).filter(Boolean);
  } catch {}
  return [...DEFAULT_IGNORED_PARAMS];
}

function saveIgnoreParams(list) {
  try { localStorage.setItem(IGNORE_PARAMS_LS_KEY, list.join(',')); } catch {}
}

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
      <button class="diff-har-btn" id="diffHarBtn" disabled>Export diff (JSON)</button>
      <button class="console-icon-btn" id="diffResetBtn" title="Reset comparison">&#10005;</button>
    </div>
    <div class="diff-toolbar diff-toolbar-row2">
      <label class="diff-label">Match by
        <select class="diff-pick" id="diffMatchMode">
          <option value="full">Full URL</option>
          <option value="path">Path only (ignore host)</option>
        </select>
      </label>
      <label class="diff-label diff-ignore-params-label">Ignore query params
        <input type="text" class="diff-filter-text" id="diffIgnoreParams" value="${escHtml(ignoreParams.join(', '))}" />
      </label>
    </div>
    <div class="diff-body" id="diffBody">
      <div class="diff-hint">Select two sessions above and click Compare.</div>
    </div>`;

  populatePickers();
  document.getElementById('diffMatchMode').value = matchMode;

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

  document.getElementById('diffMatchMode').addEventListener('change', (e) => {
    matchMode = e.target.value;
    if (rawEventsA.length || rawEventsB.length) recomputeFromRaw();
  });
  document.getElementById('diffIgnoreParams').addEventListener('change', (e) => {
    ignoreParams = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
    saveIgnoreParams(ignoreParams);
    if (rawEventsA.length || rawEventsB.length) recomputeFromRaw();
  });

  // Delegated: rows are rebuilt from scratch on every render, so a
  // per-row listener would need re-wiring each time — this survives that.
  document.getElementById('diffBody').addEventListener('click', (e) => {
    const row = e.target.closest('tr.diff-row');
    if (row && row.dataset.expandable === '1') toggleExpanded(row.dataset.key);
  });
}

function toggleExpanded(key) {
  if (expandedKeys.has(key)) expandedKeys.delete(key);
  else expandedKeys.add(key);
  renderDiffTable(document.getElementById('diffBody'));
}

function resetDiff() {
  rawEventsA = [];
  rawEventsB = [];
  rawMapA = new Map();
  rawMapB = new Map();
  lastDiffRows = [];
  diffMeta = null;
  truncatedSides = [];
  expandedKeys = new Set();
  document.getElementById('diffFilterText').value = '';
  document.getElementById('diffBody').innerHTML = '<div class="diff-hint">Select two sessions above and click Compare.</div>';
  document.getElementById('diffHarBtn').disabled = true;
}

function onGroupToggleChanged(e) {
  groupDuplicates = e.target.checked;
  if (rawMapA.size === 0 && rawMapB.size === 0) return;
  expandedKeys = new Set(); // grouped vs. per-call keys aren't comparable
  computeDiffRowsAndRender();
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
    testerBrowser.recording.timeline(idA, { limit: RECORDING_FETCH_LIMIT }),
    testerBrowser.recording.timeline(idB, { limit: RECORDING_FETCH_LIMIT }),
  ]);

  rawEventsA = evA;
  rawEventsB = evB;
  truncatedSides = [
    ...(isTruncated(evA, RECORDING_FETCH_LIMIT) ? ['A'] : []),
    ...(isTruncated(evB, RECORDING_FETCH_LIMIT) ? ['B'] : []),
  ];
  expandedKeys = new Set();

  recomputeFromRaw();
  harBtn.disabled = lastDiffRows.length === 0;
}

// Rebuilds rawMapA/rawMapB from the raw events under the current
// matchMode/ignoreParams, then recomputes rows — no re-fetch.
function recomputeFromRaw() {
  rawMapA = buildRequestMap(rawEventsA, { mode: matchMode, ignoreParams });
  rawMapB = buildRequestMap(rawEventsB, { mode: matchMode, ignoreParams });
  computeDiffRowsAndRender();
}

function computeDiffRowsAndRender() {
  lastDiffRows = computeDiffRows(rawMapA, rawMapB, { groupDuplicates, ignoreHeaders: DEFAULT_IGNORED_HEADERS });
  renderDiffTable(document.getElementById('diffBody'));
  const harBtn = document.getElementById('diffHarBtn');
  if (harBtn) harBtn.disabled = lastDiffRows.length === 0;
}

function truncationBannerHtml() {
  if (!truncatedSides.length || !diffMeta) return '';
  const lines = truncatedSides.map((side) => {
    const name = side === 'A' ? diffMeta.nameA : diffMeta.nameB;
    return `Session <b>${escHtml(name)}</b> has more than ${RECORDING_FETCH_LIMIT.toLocaleString()} recorded events — only the most recent ${RECORDING_FETCH_LIMIT.toLocaleString()} were compared.`;
  });
  return `<div class="diff-truncation-warning">${lines.join('<br>')}</div>`;
}

function renderDiffTable(body) {
  if (lastDiffRows.length === 0) {
    body.innerHTML = truncationBannerHtml() + '<div class="diff-hint">No network requests found in either session.</div>';
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
    const expandable = !!r.detail;
    const expanded = expandable && expandedKeys.has(r.key);
    const hbBadge = r.headerBodyDiffer
      ? '<span class="diff-badge hb-diff" title="Status matches but headers or body differ">&ne; headers/body</span>' : '';
    const rowHtml = `<tr class="diff-row ${r.category}${expandable ? ' diff-row-expandable' : ''}" data-key="${escHtml(r.key)}" data-expandable="${expandable ? '1' : '0'}">
      <td class="diff-method">${method}</td>
      <td class="diff-url" title="${url}">${url}</td>
      <td class="diff-st">${renderCell(r.a)}</td>
      <td class="diff-st">${renderCell(r.b)}</td>
      <td class="diff-hb">${hbBadge}</td>
    </tr>`;
    const detailHtml = expanded ? `<tr class="diff-detail-row"><td colspan="5">${renderDetailBlock(r.detail)}</td></tr>` : '';
    return rowHtml + detailHtml;
  }).join('');

  body.innerHTML = truncationBannerHtml() + meta + legend + `<div class="diff-table-wrap"><table class="diff-table">
    <thead><tr><th>Method</th><th>URL</th><th>Status A</th><th>Status B</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderDetailBlock(detail) {
  const headerLines = [
    ...detail.headerDiff.removed.map(h => `<div class="diff-detail-header removed">&minus; ${escHtml(h.name)}: ${escHtml(h.value)}</div>`),
    ...detail.headerDiff.added.map(h => `<div class="diff-detail-header added">+ ${escHtml(h.name)}: ${escHtml(h.value)}</div>`),
    ...detail.headerDiff.changed.map(h => `<div class="diff-detail-header changed">&plusmn; ${escHtml(h.name)}: ${escHtml(h.valueA)} &rarr; ${escHtml(h.valueB)}</div>`),
  ].join('');

  const bodyLine = detail.bodiesMatch === null
    ? 'Body not captured on at least one side'
    : detail.bodiesMatch
      ? 'Bodies identical'
      : `Bodies differ — A: ${detail.bodySizeA ?? '?'} bytes, B: ${detail.bodySizeB ?? '?'} bytes (&Delta; ${Math.abs((detail.bodySizeA ?? 0) - (detail.bodySizeB ?? 0))})`;

  const durA = detail.durationA !== null ? `${detail.durationA}ms` : '—';
  const durB = detail.durationB !== null ? `${detail.durationB}ms` : '—';
  const durDelta = (detail.durationA !== null && detail.durationB !== null)
    ? ` (&Delta; ${detail.durationB - detail.durationA}ms)` : '';

  return `<div class="diff-detail">
    <div class="diff-detail-section"><span class="diff-detail-label">Response headers</span>${headerLines || '<div class="diff-detail-header-none">No differences (outside the ignored set)</div>'}</div>
    <div class="diff-detail-section"><span class="diff-detail-label">Body</span> ${bodyLine}</div>
    <div class="diff-detail-section"><span class="diff-detail-label">Duration</span> A ${durA} vs B ${durB}${durDelta}</div>
  </div>`;
}

function renderCell(cell) {
  if (!cell) return '<span class="diff-status diff-absent">—</span>';
  const count = cell.count > 1 ? `<span class="diff-count" title="${cell.count} calls">×${cell.count}</span>` : '';
  const cache = cell.cache !== 'none'
    ? `<span class="diff-cache ${cell.cache}" title="${cell.cache === 'all' ? 'served from cache' : 'some calls served from cache'}">cache${cell.cache === 'mixed' ? '*' : ''}</span>`
    : '';
  return `<span class="diff-status">${escHtml(cell.label)}</span>${count}${cache}`;
}

// #232: this was never real HAR (a HAR entry doesn't have category/statusA/
// countA/... fields) — renamed to what it actually is. Content is unchanged;
// only the button label and file name are.
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
    headerBodyDiffer: r.headerBodyDiffer,
  }));
  const diffExport = {
    log: {
      version: '1.2',
      creator: { name: 'TesterBrowser', version: 'diff' },
      comment: 'Environment diff export',
      entries,
    },
  };
  const blob = new Blob([JSON.stringify(diffExport, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'session-diff.json';
  a.click();
  URL.revokeObjectURL(url);
}
