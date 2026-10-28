/* global testerBrowser */
import { escHtml, wirePillGroup, activePillValues, toCurl } from './utils.js';
import { renderEmptyState } from './empty-state.js';
import { populateSessionPickers } from './session-picker.js';
import { showStatus } from './status-msg.js';
import {
  DEFAULT_IGNORED_PARAMS, DEFAULT_IGNORED_HEADERS,
  buildRequestMap, computeDiffRows, isTruncated,
  rowBucket, summarizeDiffRows, filterDiffRows, splitUrlForDisplay,
  splitChange, statusClassOf, bodyTextForDiff, lineDiff,
} from './diff-logic.js';

const RECORDING_FETCH_LIMIT = 5000;
const IGNORE_PARAMS_LS_KEY = 'diffIgnoreParams';
const MAX_DIFF_LINE_CHARS = 2000;
// "Changed only" by default: identical requests are usually noise.
const DEFAULT_BUCKETS = ['changed', 'added', 'removed'];

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
let selectedKey = null;
// Session names must be captured at compare time, not looked up later by id:
// destroySession removes a closed session from sessions.list() entirely, so
// a later re-lookup would silently fail once a compared session is closed.
let diffMeta = null;
// Body line diffs are computed lazily on expand and cached per detail
// object, so typing in the filter box doesn't re-run the LCS every keystroke.
let bodyDiffCache = new WeakMap();

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

const bucketPill = (cat, label, title, key) =>
  `<button type="button" class="filter-pill${DEFAULT_BUCKETS.includes(cat) ? ' on' : ''}" data-cat="${cat}" title="${title}"><span class="diff-key diff-key-${key}"></span>${label}<span class="pill-count"></span></button>`;
const statusPill = (cls, label) =>
  `<button type="button" class="filter-pill on" data-status="${cls}" title="Show rows with a ${label} status on either side">${label}</button>`;

export function initDiff() {
  const panel = document.getElementById('diffPanel');
  if (panel.dataset.initialized) return;
  panel.dataset.initialized = '1';

  panel.innerHTML = `
    <div class="diff-toolbar diff-toolbar-main">
      <label class="diff-pickwrap"><span class="diff-pick-key">A</span>
        <select class="diff-pick" id="diffPickA" aria-label="Session A"></select>
      </label>
      <button type="button" class="console-icon-btn" id="diffSwapBtn" title="Swap A and B" aria-label="Swap sessions A and B"><i class="icon-arrow-left-right" aria-hidden="true"></i></button>
      <label class="diff-pickwrap"><span class="diff-pick-key">B</span>
        <select class="diff-pick" id="diffPickB" aria-label="Session B"></select>
      </label>
      <div class="seg" id="diffMatchSeg" role="group" aria-label="Match by">
        <button type="button" class="seg-btn on" data-mode="full" aria-pressed="true" title="Match requests by method + full URL">Match full URL</button>
        <button type="button" class="seg-btn" data-mode="path" aria-pressed="false" title="Match requests by method + path, ignoring the host">Match path</button>
      </div>
      <label class="diff-label diff-group-toggle" title="Collapse repeated calls to the same request into one row">
        <input type="checkbox" id="diffGroupToggle" checked /> Group duplicates
      </label>
      <span class="diff-spacer"></span>
      <span class="status-msg" id="diffStatus" role="status" aria-live="polite"></span>
      <button type="button" class="net-chip" id="diffHarBtn" disabled><i class="icon-file-down" aria-hidden="true"></i>Export JSON</button>
      <button type="button" class="console-icon-btn" id="diffResetBtn" title="Reset comparison" aria-label="Reset comparison"><i class="icon-ban" aria-hidden="true"></i></button>
      <button type="button" class="diff-run-btn" id="diffRunBtn">Compare</button>
    </div>
    <div class="diff-toolbar diff-toolbar-row2" role="group" aria-labelledby="diffIgnoreLabel">
      <span class="diff-label" id="diffIgnoreLabel">Ignored query params</span>
      <ul class="diff-ignore-chips" id="diffIgnoreChips" aria-labelledby="diffIgnoreLabel"></ul>
      <input type="text" class="diff-filter-text diff-ignore-input" id="diffIgnoreParams"
        placeholder="Add, e.g. session_id or utm_*" aria-label="Add ignored query params (comma separated)" />
      <button type="button" class="diff-small-btn" id="diffIgnoreAddBtn">Add</button>
      <button type="button" class="diff-link-btn" id="diffIgnoreDefaultsBtn">Restore defaults</button>
    </div>
    <div class="diff-toolbar diff-toolbar-row2 diff-filter-row" id="diffFilterRow" hidden>
      <div class="filter-pills diff-chips" id="diffCatPills" role="group" aria-label="Result">
        ${bucketPill('changed', 'Different', 'Status, response headers or body differ', 'changed')}
        ${bucketPill('removed', 'Only in A', 'Only in Session A', 'removed')}
        ${bucketPill('added', 'Only in B', 'Only in Session B', 'added')}
        ${bucketPill('unchanged', 'Same', 'Identical in both sessions', 'unchanged')}
      </div>
      <div class="filter-pills" id="diffStatusPills" role="group" aria-label="Status class">
        ${statusPill('2xx', '2xx')}${statusPill('3xx', '3xx')}${statusPill('4xx', '4xx')}${statusPill('5xx', '5xx')}${statusPill('failed', 'Failed')}
      </div>
      <input type="text" class="diff-filter-text" id="diffFilterText" aria-label="Filter requests by URL"
        placeholder="Filter URLs, e.g. api -analytics" />
    </div>
    <div class="diff-body" id="diffBody" role="region" aria-label="Comparison results" tabindex="0"></div>`;

  renderIgnoreChips();
  renderBody();
  populatePickers();
  document.getElementById('diffRunBtn').addEventListener('click', runDiff);
  /** @type {HTMLButtonElement} */ (document.getElementById('diffHarBtn')).addEventListener('click', exportDiffHar);
  document.getElementById('diffGroupToggle').addEventListener('change', onGroupToggleChanged);
  document.getElementById('diffResetBtn').addEventListener('click', resetDiff);
  /** @type {HTMLInputElement} */ (document.getElementById('diffFilterText')).addEventListener('input', renderBody);
  wirePillGroup(document.getElementById('diffCatPills'), renderBody);
  wirePillGroup(document.getElementById('diffStatusPills'), renderBody);
  document.querySelectorAll('#diffMatchSeg .seg-btn').forEach((btn) => btn.addEventListener('click', () => {
    matchMode = /** @type {HTMLElement} */ (btn).dataset.mode;
    document.querySelectorAll('#diffMatchSeg .seg-btn').forEach((b) => {
      const on = /** @type {HTMLElement} */ (b).dataset.mode === matchMode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    if (rawEventsA.length || rawEventsB.length) recomputeFromRaw();
  }));
  document.getElementById('diffSwapBtn').addEventListener('click', () => {
    const pa = /** @type {HTMLSelectElement} */ (document.getElementById('diffPickA'));
    const pb = /** @type {HTMLSelectElement} */ (document.getElementById('diffPickB'));
    [pa.value, pb.value] = [pb.value, pa.value];
  });

  // 'change' fires on Enter and on blur, so typing a param and tabbing away
  // adds it too — nothing typed is silently lost.
  const ignoreInput = /** @type {HTMLInputElement} */ (document.getElementById('diffIgnoreParams'));
  ignoreInput.addEventListener('change', () => addIgnoreParams(ignoreInput.value));
  document.getElementById('diffIgnoreAddBtn').addEventListener('click', () => {
    addIgnoreParams(ignoreInput.value);
    ignoreInput.focus();
  });
  document.getElementById('diffIgnoreDefaultsBtn').addEventListener('click', () => {
    setIgnoreParams([...DEFAULT_IGNORED_PARAMS]);
  });
  document.getElementById('diffIgnoreChips').addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('button[data-param]');
    if (!btn) return;
    const idx = ignoreParams.indexOf(btn.dataset.param);
    setIgnoreParams(ignoreParams.filter(p => p !== btn.dataset.param));
    // Keep keyboard focus in the chip list rather than dropping it to <body>.
    const remaining = document.querySelectorAll('#diffIgnoreChips button[data-param]');
    (remaining[Math.min(idx, remaining.length - 1)] ?? ignoreInput).focus();
  });

  // Delegated: rows are rebuilt from scratch on every render, so per-row
  // listeners would need re-wiring each time — this survives that.
  const diffBody = document.getElementById('diffBody');
  diffBody.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const copyBtn = target.closest('button[data-curl]');
    if (copyBtn) { copyCurl(copyBtn.dataset.key, copyBtn.dataset.curl); return; }
    if (target.closest('#diffShowAllBtn')) { showAllRows(); return; }
    if (target.closest('#diffDetail')) return; // let text in the pane be selected
    const row = target.closest('tr.diff-row');
    if (row) selectRow(row.dataset.key);
  });
  diffBody.addEventListener('keydown', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest?.('tr.diff-row');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectRow(row.dataset.key); }
  });
}

// ── Ignored query params ────────────────────────────────────────────────

function addIgnoreParams(text) {
  const input = /** @type {HTMLInputElement} */ (document.getElementById('diffIgnoreParams'));
  input.value = '';
  const lower = new Set(ignoreParams.map(p => p.toLowerCase()));
  const toAdd = [];
  for (const p of String(text).split(/[,\s]+/).map(s => s.trim()).filter(Boolean)) {
    if (lower.has(p.toLowerCase())) continue;
    lower.add(p.toLowerCase());
    toAdd.push(p);
  }
  if (toAdd.length) setIgnoreParams([...ignoreParams, ...toAdd]);
}

function setIgnoreParams(list) {
  ignoreParams = list;
  saveIgnoreParams(ignoreParams);
  renderIgnoreChips();
  if (rawEventsA.length || rawEventsB.length) recomputeFromRaw();
}

function renderIgnoreChips() {
  const ul = document.getElementById('diffIgnoreChips');
  ul.innerHTML = ignoreParams.length
    ? ignoreParams.map(p => `<li class="panel-chip diff-ignore-chip">${escHtml(p)}<button type="button" class="diff-chip-x" data-param="${escHtml(p)}" aria-label="Stop ignoring ${escHtml(p)}" title="Stop ignoring ${escHtml(p)}">&times;</button></li>`).join('')
    : '<li class="diff-ignore-none">None. Every query param counts when matching.</li>';
}

// ── Actions ─────────────────────────────────────────────────────────────

function selectRow(key) {
  selectedKey = key;
  renderBody();
  const row = [...document.querySelectorAll('#diffBody tr.diff-row')].find((r) => /** @type {HTMLElement} */ (r).dataset.key === key);
  /** @type {HTMLElement | undefined} */ (row)?.focus();
}

function showAllRows() {
  for (const pill of document.querySelectorAll('#diffCatPills .filter-pill, #diffStatusPills .filter-pill')) {
    pill.classList.add('on');
    pill.setAttribute('aria-pressed', 'true');
  }
  /** @type {HTMLInputElement} */ (document.getElementById('diffFilterText')).value = '';
  renderBody();
}

async function copyCurl(key, side) {
  const row = lastDiffRows.find(r => r.key === key);
  const req = side === 'B' ? row?.requestB : row?.requestA;
  if (!req) return;
  try {
    await testerBrowser.clipboard.write(toCurl(req));
    const name = side === 'B' ? diffMeta?.nameB : diffMeta?.nameA;
    showStatus('diffStatus', `Copied cURL for ${req.method} ${splitUrlForDisplay(req.url).path}${name ? ` (${name})` : ''}`);
  } catch {
    showStatus('diffStatus', 'Could not copy to the clipboard', true);
  }
}

function resetDiff() {
  rawEventsA = [];
  rawEventsB = [];
  rawMapA = new Map();
  rawMapB = new Map();
  lastDiffRows = [];
  diffMeta = null;
  truncatedSides = [];
  selectedKey = null;
  bodyDiffCache = new WeakMap();
  /** @type {HTMLInputElement} */ (document.getElementById('diffFilterText')).value = '';
  /** @type {HTMLButtonElement} */ (document.getElementById('diffHarBtn')).disabled = true;
  renderBody();
}

function onGroupToggleChanged(e) {
  groupDuplicates = e.target.checked;
  if (rawMapA.size === 0 && rawMapB.size === 0) return;
  selectedKey = null; // grouped vs. per-call keys aren't comparable
  computeDiffRowsAndRender();
}

export async function refreshDiffPickers() {
  const pickA = /** @type {HTMLSelectElement} */ (document.getElementById('diffPickA'));
  if (!pickA) return; // diff panel not yet initialised
  await populatePickers();
}

async function populatePickers() {
  const sessions = await populateSessionPickers('diffPickA', 'diffPickB');
  if (!sessions) return; // a newer call already superseded this one
  cachedSessions = sessions;
  if (!diffMeta) renderBody(); // the first-run hint depends on how many tabs are open
}

async function runDiff() {
  const idA = /** @type {HTMLSelectElement} */ (document.getElementById('diffPickA'))?.value;
  const idB = /** @type {HTMLSelectElement} */ (document.getElementById('diffPickB'))?.value;
  const body = document.getElementById('diffBody');
  const harBtn = /** @type {HTMLButtonElement} */ (document.getElementById('diffHarBtn'));
  if (!idA || !idB) { body.innerHTML = '<div class="diff-hint diff-hint-warn" role="alert">Pick both Session A and Session B first.</div>'; return; }
  if (idA === idB) { body.innerHTML = '<div class="diff-hint diff-hint-warn" role="alert">Pick two different sessions.</div>'; return; }

  body.innerHTML = '<div class="diff-hint" role="status">Loading…</div>';
  harBtn.disabled = true;

  const nameA = cachedSessions.find(s => s.id === idA)?.name ?? idA;
  const nameB = cachedSessions.find(s => s.id === idB)?.name ?? idB;
  const comparedAt = Date.now();

  let evA, evB;
  try {
    [evA, evB] = await Promise.all([
      testerBrowser.recording.timeline(idA, { limit: RECORDING_FETCH_LIMIT }),
      testerBrowser.recording.timeline(idB, { limit: RECORDING_FETCH_LIMIT }),
    ]);
  } catch (err) {
    body.innerHTML = `<div class="diff-hint diff-hint-warn" role="alert">Could not read the recordings: ${escHtml(err?.message ?? err)}</div>`;
    return;
  }

  // Assigned only once the fetch is done, so a filter re-render while
  // loading can't show the previous rows under the new session names.
  diffMeta = { nameA, nameB, comparedAt };
  rawEventsA = evA;
  rawEventsB = evB;
  truncatedSides = [
    ...(isTruncated(evA, RECORDING_FETCH_LIMIT) ? ['A'] : []),
    ...(isTruncated(evB, RECORDING_FETCH_LIMIT) ? ['B'] : []),
  ];
  selectedKey = null;

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
  bodyDiffCache = new WeakMap();
  renderBody();
  const harBtn = /** @type {HTMLButtonElement} */ (document.getElementById('diffHarBtn'));
  if (harBtn) harBtn.disabled = lastDiffRows.length === 0;
}

// ── Rendering ───────────────────────────────────────────────────────────

function renderBody() {
  const body = document.getElementById('diffBody');
  if (!body) return;
  // #327: result filters only mean something once a comparison has run.
  document.getElementById('diffFilterRow').hidden = !diffMeta;
  if (!diffMeta) { body.replaceChildren(firstRunState()); return; }
  if (lastDiffRows.length === 0) {
    body.innerHTML = truncationBannerHtml() + metaHtml() +
      '<div class="diff-hint">No network requests found in either session. Load a page in both tabs, then click Compare again.</div>';
    return;
  }
  renderDiffTable(body);
}

// #303: the pre-comparison state, built with the shared empty state.
function firstRunState() {
  return renderEmptyState({
    icon: 'git-compare', tone: 'accent', title: 'Network diff',
    text: cachedSessions.length < 2
      ? 'Open a second tab, then compare the two tabs\' recorded requests.'
      : 'Pick two sessions to compare their recorded requests.',
    // #327: the toolbar's Compare is the one call to action.
  });
}

function metaHtml() {
  return diffMeta ? `<div class="diff-meta">Compared <b>${escHtml(diffMeta.nameA)}</b> (A) vs ` +
    `<b>${escHtml(diffMeta.nameB)}</b> (B) at ${new Date(diffMeta.comparedAt).toLocaleTimeString()}</div>` : '';
}

function truncationBannerHtml() {
  if (!truncatedSides.length || !diffMeta) return '';
  const lines = truncatedSides.map((side) => {
    const name = side === 'A' ? diffMeta.nameA : diffMeta.nameB;
    return `Session <b>${escHtml(name)}</b> has more than ${RECORDING_FETCH_LIMIT.toLocaleString()} recorded events — only the most recent ${RECORDING_FETCH_LIMIT.toLocaleString()} were compared.`;
  });
  return `<div class="diff-truncation-warning" role="note">${lines.join('<br>')}</div>`;
}

function updateChipCounts(counts) {
  // Always reflects the full comparison, independent of the filters.
  for (const [bucket, n] of Object.entries(counts)) {
    const span = document.querySelector(`#diffCatPills .filter-pill[data-cat="${bucket}"] .pill-count`);
    if (span) span.textContent = String(n);
  }
}

function renderDiffTable(body) {
  const counts = summarizeDiffRows(lastDiffRows);
  updateChipCounts(counts);
  const visible = filterDiffRows(lastDiffRows, {
    buckets: activePillValues(document.getElementById('diffCatPills'), 'cat'),
    statusClasses: activePillValues(document.getElementById('diffStatusPills'), 'status'),
    text: /** @type {HTMLInputElement} */ (document.getElementById('diffFilterText')).value,
  });

  const showAllBtn = '<button type="button" class="diff-link-btn" id="diffShowAllBtn">Show all</button>';
  let filterNote = '';
  if (visible.length === 0) {
    const allSame = counts.unchanged === counts.total;
    filterNote = `<div class="diff-hint">${allSame
      ? `No differences: all ${counts.total} requests have the same status, headers and body in both sessions.`
      : 'No requests match the current filters.'} ${showAllBtn}</div>`;
  } else if (visible.length < lastDiffRows.length) {
    filterNote = `<div class="diff-filter-note">Showing ${visible.length} of ${lastDiffRows.length}. ${showAllBtn}</div>`;
  }

  const rows = visible.map((r) => rowHtml(r)).join('');
  const table = visible.length ? `<div class="diff-table-wrap"><table class="diff-table">
    <colgroup><col><col style="width:56px"><col style="width:76px"><col style="width:72px"><col style="width:76px"><col style="width:72px"><col style="width:76px"><col style="width:150px"></colgroup>
    <thead><tr>
      <th>Path</th><th>Method</th><th class="diff-num">A status</th><th class="diff-num">A time</th>
      <th class="diff-num">B status</th><th class="diff-num">B time</th><th class="diff-num">&Delta; time</th><th>Result</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>` : '';

  const selected = visible.find((r) => r.key === selectedKey) ?? null;
  body.innerHTML = `<div class="diff-split">
    <div class="diff-main">${truncationBannerHtml()}${metaHtml()}${filterNote}${table}</div>
    <aside class="diff-pane" id="diffDetail" aria-label="Request differences">${selected ? renderDetailPane(selected) : '<div class="diff-pane-hint">Select a row to see how the request differs.</div>'}</aside>
  </div>`;
}

function timeText(ms) { return typeof ms === 'number' ? `${Math.round(ms)} ms` : ''; }

function rowHtml(r) {
  const bucket = rowBucket(r);
  const { host, path } = splitUrlForDisplay(r.url);
  const key = escHtml(r.key);
  const selected = r.key === selectedKey;
  const delta = (typeof r.durationA === 'number' && typeof r.durationB === 'number')
    ? Math.round(r.durationB - r.durationA) : null;
  const deltaText = delta === null ? '' : `${delta > 0 ? '+' : ''}${delta} ms`;

  return `<tr class="diff-row ${r.category} bucket-${bucket}${selected ? ' selected' : ''}" data-key="${key}" data-bucket="${bucket}" tabindex="0" aria-selected="${selected}">
    <td class="diff-url" title="${escHtml(r.url)}"><span class="diff-path">${escHtml(path)}</span>${host ? ` <span class="diff-host">${escHtml(host)}</span>` : ''}</td>
    <td class="diff-method">${escHtml(r.method)}</td>
    <td class="diff-st diff-num">${cellHtml(r.a, 'A')}</td>
    <td class="diff-time diff-num">${timeText(r.durationA)}</td>
    <td class="diff-st diff-num">${cellHtml(r.b, 'B')}</td>
    <td class="diff-time diff-num">${timeText(r.durationB)}</td>
    <td class="diff-time diff-num${delta !== null && delta > 200 ? ' diff-slow' : ''}">${deltaText}</td>
    <td class="diff-res">${notesHtml(r, bucket)}</td>
  </tr>`;
}

// The Result column's tag: Same / Same · ≠ body / Different status / Only in A / Only in B.
function notesHtml(r, bucket) {
  if (bucket === 'added') return '<span class="diff-badge only-b">Only in B</span>';
  if (bucket === 'removed') return '<span class="diff-badge only-a">Only in A</span>';
  if (r.category === 'diff') return '<span class="diff-badge diff">Different status</span>';
  if (r.headerBodyDiffer && r.detail) {
    const what = [
      r.detail.headersDiffer ? 'headers' : null,
      r.detail.bodiesMatch === false ? 'body' : null,
    ].filter(Boolean).join(', ');
    return `<span class="diff-badge hb-diff" title="Response ${what} differ (first call on each side)">Same &middot; &ne; ${what}</span>`;
  }
  return '<span class="diff-badge same">Same</span>';
}

function statusCodeHtml(label) {
  return String(label).split('/').map(s =>
    `<span class="diff-status st-${statusClassOf(s)}">${escHtml(s)}</span>`).join('<span class="diff-st-sep">/</span>');
}

function cellHtml(cell, side) {
  if (!cell) return `<span class="diff-absent" title="Not requested in Session ${side}">—</span>`;
  const count = cell.count > 1 ? `<span class="diff-count" title="${cell.count} calls">×${cell.count}</span>` : '';
  const cache = cell.cache !== 'none'
    ? `<span class="diff-cache ${cell.cache}" title="${cell.cache === 'all' ? 'served from cache' : 'some calls served from cache'}">cache${cell.cache === 'mixed' ? '*' : ''}</span>`
    : '';
  return `${statusCodeHtml(cell.label)}${count}${cache}`;
}

function highlightedPair(a, b) {
  const { prefix, midA, midB, suffix } = splitChange(a, b);
  const p = escHtml(prefix);
  const s = escHtml(suffix);
  return {
    a: `${p}<mark class="diff-mark-a">${escHtml(midA)}</mark>${s}`,
    b: `${p}<mark class="diff-mark-b">${escHtml(midB)}</mark>${s}`,
  };
}

function headerTableHtml(hd) {
  const rows = [
    ...hd.changed.map((h) => {
      const hl = highlightedPair(h.valueA, h.valueB);
      return `<tr class="changed"><th scope="row">${escHtml(h.name)}</th><td>${hl.a}</td><td>${hl.b}</td></tr>`;
    }),
    ...hd.removed.map(h => `<tr class="removed"><th scope="row">${escHtml(h.name)}</th><td>${escHtml(h.value)}</td><td class="diff-absent">(missing)</td></tr>`),
    ...hd.added.map(h => `<tr class="added"><th scope="row">${escHtml(h.name)}</th><td class="diff-absent">(missing)</td><td>${escHtml(h.value)}</td></tr>`),
  ].join('');
  if (!rows) {
    return `<div class="diff-detail-header-none">No differences (ignoring ${DEFAULT_IGNORED_HEADERS.map(escHtml).join(', ')})</div>`;
  }
  return `<table class="diff-hdr-table"><thead><tr><th scope="col">Header</th><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function bodyDiffHtml(detail) {
  if (detail.bodiesMatch === null) return '<div class="diff-detail-note">Body not captured on at least one side.</div>';
  if (detail.bodiesMatch) return '<div class="diff-detail-note">Bodies identical.</div>';
  const sizes = `A ${detail.bodySizeA ?? '?'} chars, B ${detail.bodySizeB ?? '?'} chars (&Delta; ${Math.abs((detail.bodySizeA ?? 0) - (detail.bodySizeB ?? 0))})`;
  let result = bodyDiffCache.get(detail);
  if (!result) {
    const textA = bodyTextForDiff(detail.bodyA);
    const textB = bodyTextForDiff(detail.bodyB);
    result = (textA === null || textB === null) ? { binary: true } : lineDiff(textA, textB);
    bodyDiffCache.set(detail, result);
  }
  if (result.binary) {
    return `<div class="diff-detail-note">Bodies differ: ${sizes}. Binary content, no text diff.</div>`;
  }
  if (result.identical) {
    return `<div class="diff-detail-note">Bodies differ only in formatting/whitespace: ${sizes}.</div>`;
  }
  if (result.tooLarge) {
    return `<div class="diff-detail-note">Bodies differ: ${sizes}. Too large for an inline diff; first difference at line ${result.firstDiffLine}.</div>`;
  }
  const lines = result.lines.map((l) => {
    if (l.type === 'gap') return `<div class="dl dl-gap">⋯ ${l.count} unchanged line${l.count === 1 ? '' : 's'}</div>`;
    const cls = l.type === '+' ? 'dl-add' : l.type === '-' ? 'dl-del' : 'dl-ctx';
    const sign = l.type === '+' ? '+' : l.type === '-' ? '&minus;' : '&nbsp;';
    // Minified bodies can be one enormous line; don't put megabytes in the DOM.
    const text = l.text.length > MAX_DIFF_LINE_CHARS ? `${l.text.slice(0, MAX_DIFF_LINE_CHARS)}…` : l.text;
    return `<div class="dl ${cls}"><span class="dl-sign" aria-hidden="true">${sign}</span>${escHtml(text)}</div>`;
  }).join('');
  const more = result.truncated ? '<div class="dl dl-gap">… diff truncated</div>' : '';
  return `<div class="diff-detail-note">Bodies differ: ${sizes}. <span class="dl-legend"><span class="dl-del">&minus; only in A</span> <span class="dl-add">+ only in B</span></span></div>
    <div class="diff-body-diff" role="region" aria-label="Body diff" tabindex="0">${lines}${more}</div>`;
}

// "Response body · 2 lines differ" under the pane's title.
function bodySummary(detail) {
  if (detail.bodiesMatch === null) return 'Response body · not captured on both sides';
  if (detail.bodiesMatch) return 'Response body · identical';
  const result = bodyDiffCache.get(detail);
  if (result && !result.binary && !result.identical && !result.tooLarge && result.lines) {
    const del = result.lines.filter((l) => l.type === '-').length;
    const add = result.lines.filter((l) => l.type === '+').length;
    const n = Math.max(del, add);
    return `Response body · ${n} line${n === 1 ? '' : 's'} differ`;
  }
  return 'Response body · differs';
}

function headerSummary(detail) {
  const hd = detail.headerDiff;
  const n = hd.changed.length + hd.added.length + hd.removed.length;
  return n === 0 ? 'Headers · identical' : `Headers · ${n} differ${n === 1 ? 's' : ''}`;
}

function renderDetailPane(r) {
  const { path } = splitUrlForDisplay(r.url);
  const key = escHtml(r.key);
  const detail = r.detail;
  const copy = ['A', 'B'].filter(s => (s === 'A' ? r.requestA : r.requestB))
    .map(s => `<button type="button" class="diff-small-btn" data-curl="${s}" data-key="${key}">Copy ${s} as cURL</button>`).join('');

  let html = `<div class="diff-pane-title">${escHtml(r.method)} ${escHtml(path)}</div>`;
  if (!detail) {
    // Present on one side only: nothing to compare, just say which.
    html += `<div class="diff-pane-sub">${r.requestA ? 'Only in Session A' : 'Only in Session B'}</div>`;
  } else {
    const bodyHtml = bodyDiffHtml(detail); // fills bodyDiffCache, read by bodySummary
    html += `<div class="diff-pane-sub">${escHtml(bodySummary(detail))}</div>${bodyHtml}`;
    html += `<div class="diff-pane-sub">${escHtml(headerSummary(detail))}</div>${headerTableHtml(detail.headerDiff)}`;
  }
  html += `<div class="diff-pane-meta"><span class="diff-detail-label">Full URL</span> <span class="diff-detail-url">${escHtml(r.url)}</span></div>`;
  if (copy) html += `<div class="diff-detail-actions">${copy}</div>`;
  return html;
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
