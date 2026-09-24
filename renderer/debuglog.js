/* global testerBrowser */
import { escHtml, wirePillGroup, activePillValues, matchesFreeText } from './utils.js';

let initialized = false;
let pollHandle = null;
// The full set of entries fetched so far this "session" of the panel being
// open (across tab switches, since stopDebugLogPolling() only pauses the
// interval — it doesn't drop what's already loaded). Reset to empty only
// when debug mode is off, so turning it back on re-fetches everything that
// accumulated while the panel wasn't polling instead of silently skipping it.
let lastEntries = [];
let lastSeenId = 0;

const EMPTY_STATE_OFF =
  'Debug mode is off — enable it in Settings → General to see TesterBrowser\'s own internal logs';

export async function initDebugLog() {
  if (!initialized) {
    initialized = true;
    document.getElementById('debugLogPanel').innerHTML = `
      <div id="debugLogControls">
        <span class="filter-label">Filter</span>
        <input id="debugLogFilterText" placeholder="Filter debug log…" />
        <div class="filter-pills" id="debugLogLevelPills">
          <button class="filter-pill on" data-level="error" title="Errors">Error<span class="pill-count"></span></button>
          <button class="filter-pill on" data-level="warn"  title="Warnings">Warn<span class="pill-count"></span></button>
          <button class="filter-pill on" data-level="info"  title="Info">Info<span class="pill-count"></span></button>
          <button class="filter-pill on" data-level="debug" title="Debug">Debug<span class="pill-count"></span></button>
        </div>
        <select id="debugLogSourceFilter" title="Filter by source"><option value="">All sources</option></select>
        <select id="debugLogSessionFilter" title="Filter by session"><option value="">All sessions</option></select>
        <button class="console-icon-btn" id="copyDebugLogBtn" title="Copy debug log to clipboard">&#128203;</button>
      </div>
      <div class="debuglog-wrap"><div id="debugLogList" class="debuglog-list"></div></div>`;

    wirePillGroup(document.getElementById('debugLogLevelPills'), renderDebugLog);
    document.getElementById('debugLogFilterText').addEventListener('input', renderDebugLog);
    document.getElementById('debugLogSourceFilter').addEventListener('change', renderDebugLog);
    document.getElementById('debugLogSessionFilter').addEventListener('change', renderDebugLog);
    document.getElementById('copyDebugLogBtn').addEventListener('click', copyDebugLog);
    // Delegated so newly-appended rows (poll ticks never touch existing
    // DOM — see pollDebugLog()) don't need their own listener wired up.
    document.getElementById('debugLogList').addEventListener('click', (e) => {
      const row = e.target.closest('.debuglog-row.has-ctx');
      if (row) row.closest('.debuglog-entry').classList.toggle('expanded');
    });
  }
  await pollDebugLog();
  stopDebugLogPolling();
  pollHandle = setInterval(pollDebugLog, 1000);
}

export function stopDebugLogPolling() {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
}

async function pollDebugLog() {
  const controls = document.getElementById('debugLogControls');
  const list = document.getElementById('debugLogList');
  if (!list) return;

  const settings = await testerBrowser.settings.get();
  if (!settings.debugMode) {
    controls.style.display = 'none';
    lastEntries = [];
    lastSeenId = 0;
    list.innerHTML = `<div class="debuglog-empty">${escHtml(EMPTY_STATE_OFF)}</div>`;
    return;
  }

  controls.style.display = 'flex';
  const fresh = await testerBrowser.app.getDebugLog(lastSeenId || undefined);
  if (!fresh.length) {
    // Nothing new — but on the very first poll (nothing loaded yet at all)
    // the list is still blank, so show the friendly empty state once.
    if (!lastEntries.length && !list.children.length) {
      list.innerHTML = '<div class="debuglog-empty">No internal errors logged yet.</div>';
    }
    return;
  }

  lastEntries = lastEntries.concat(fresh);
  lastSeenId = fresh[fresh.length - 1].id ?? lastSeenId;
  syncFilterOptions();
  appendRows(fresh);
}

// Adds <option>s for any source/sessionId not already represented, without
// touching the user's current selection (a poll tick that introduces a new
// source must not reset what they're already filtering on).
function syncFilterOptions() {
  const sourceSelect = document.getElementById('debugLogSourceFilter');
  const sessionSelect = document.getElementById('debugLogSessionFilter');
  const knownSources = new Set([...sourceSelect.options].map((o) => o.value).filter(Boolean));
  const knownSessions = new Set([...sessionSelect.options].map((o) => o.value).filter(Boolean));

  for (const e of lastEntries) {
    if (e.source && !knownSources.has(e.source)) {
      knownSources.add(e.source);
      const opt = document.createElement('option');
      opt.value = e.source;
      opt.textContent = e.source;
      sourceSelect.appendChild(opt);
    }
    if (e.sessionId && !knownSessions.has(e.sessionId)) {
      knownSessions.add(e.sessionId);
      const opt = document.createElement('option');
      opt.value = e.sessionId;
      opt.textContent = getSessionLabel(e.sessionId);
      sessionSelect.appendChild(opt);
    }
  }
}

function getSessionLabel(sessionId) {
  if (!sessionId) return '';
  let nameEl = null;
  try { nameEl = document.querySelector(`.tab[data-id="${CSS.escape(sessionId)}"] .tab-name`); } catch {}
  if (nameEl) return nameEl.textContent;
  return sessionId.slice(0, 8);
}

function currentFilters() {
  const activeLevels = activePillValues(document.getElementById('debugLogLevelPills'), 'level');
  const source = document.getElementById('debugLogSourceFilter').value;
  const sessionId = document.getElementById('debugLogSessionFilter').value;
  const filterText = document.getElementById('debugLogFilterText').value;
  return { activeLevels, source, sessionId, filterText };
}

function matchesFilters(e, f) {
  if (!f.activeLevels.has(e.level)) return false;
  if (f.source && e.source !== f.source) return false;
  if (f.sessionId && e.sessionId !== f.sessionId) return false;
  const haystack = `${e.message} ${e.source} ${e.ctx ? JSON.stringify(e.ctx) : ''}`;
  return matchesFreeText(haystack, f.filterText);
}

function updatePillCounts() {
  document.querySelectorAll('#debugLogLevelPills .filter-pill').forEach((btn) => {
    const n = lastEntries.filter((e) => e.level === btn.dataset.level).length;
    const span = btn.querySelector('.pill-count');
    if (span) span.textContent = n > 0 ? n : '';
  });
}

// Scroll position tracking: #debugLogPanel (not debugLogList/debuglog-wrap)
// is the actual scrolling element — see style.css.
function isScrolledToBottom() {
  const panel = document.getElementById('debugLogPanel');
  if (!panel) return true;
  return panel.scrollHeight - panel.scrollTop - panel.clientHeight < 4;
}

function scrollToBottom() {
  const panel = document.getElementById('debugLogPanel');
  if (panel) panel.scrollTop = panel.scrollHeight;
}

// Poll-tick path: appends only the newly-fetched entries that match the
// current filters, leaving every existing row untouched so an in-progress
// text selection survives — the one thing a full innerHTML rebuild
// (renderDebugLog(), used only on an actual filter change) can't do.
function appendRows(fresh) {
  const list = document.getElementById('debugLogList');
  updatePillCounts();

  const f = currentFilters();
  const matching = fresh.filter((e) => matchesFilters(e, f));
  if (!matching.length) return;

  const wasEmpty = list.querySelector('.debuglog-empty');
  const pinToBottom = isScrolledToBottom();
  if (wasEmpty) list.innerHTML = '';
  list.insertAdjacentHTML('beforeend', matching.map(buildRowHtml).join(''));
  if (pinToBottom) scrollToBottom();
}

function renderDebugLog() {
  const list = document.getElementById('debugLogList');
  if (!list) return;

  updatePillCounts();

  if (!lastEntries.length) {
    list.innerHTML = '<div class="debuglog-empty">No internal errors logged yet.</div>';
    return;
  }

  const f = currentFilters();
  const filtered = lastEntries.filter((e) => matchesFilters(e, f));

  if (!filtered.length) {
    list.innerHTML = '<div class="debuglog-empty">No entries match the current filter.</div>';
    return;
  }

  const pinToBottom = isScrolledToBottom();
  list.innerHTML = filtered.map(buildRowHtml).join('');
  if (pinToBottom) scrollToBottom();
}

function buildRowHtml(e) {
  const hasCtx = e.ctx && Object.keys(e.ctx).length > 0;
  const sessionLabel = e.sessionId ? getSessionLabel(e.sessionId) : '';
  return `
    <div class="debuglog-entry" data-id="${e.id ?? ''}">
      <div class="debuglog-row${hasCtx ? ' has-ctx' : ''}">
        <span class="debuglog-level debuglog-level-${e.level}">${e.level}</span>
        <span class="debuglog-ts">${new Date(e.ts).toLocaleTimeString()}</span>
        <span class="debuglog-source">${escHtml(e.source || 'app')}</span>
        <span class="debuglog-session">${escHtml(sessionLabel)}</span>
        <span class="debuglog-msg">${escHtml(e.message)}</span>
      </div>
      ${hasCtx ? `<pre class="debuglog-ctx">${escHtml(JSON.stringify(e.ctx, null, 2))}</pre>` : ''}
    </div>`;
}

async function copyDebugLog() {
  const text = lastEntries.length
    ? lastEntries.map(formatEntryForCopy).join('\n')
    : 'No internal errors logged yet.';
  await testerBrowser.clipboard.write(text);
  const btn = document.getElementById('copyDebugLogBtn');
  const prev = btn.textContent;
  btn.textContent = '✓';
  setTimeout(() => { btn.textContent = prev; }, 1500);
}

function formatEntryForCopy(e) {
  const session = e.sessionId ? ` (${getSessionLabel(e.sessionId)})` : '';
  const ctx = e.ctx && Object.keys(e.ctx).length > 0 ? ` ${JSON.stringify(e.ctx)}` : '';
  return `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase()} [${e.source || 'app'}]${session} ${e.message}${ctx}`;
}
