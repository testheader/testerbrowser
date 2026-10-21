/* global testerBrowser */
import { escHtml, matchesFreeText } from './utils.js';
import { getActiveConsoleTab } from './console-tabs.js';
import { pollWhileVisible } from './poll.js';
import { renderEmptyState } from './empty-state.js';
import { openSettings } from './settings.js';

let initialized = false;
// The full set of entries fetched so far this "session" of the panel being
// open (across tab switches — pollWhileVisible just skips fn() while
// hidden, it doesn't drop what's already loaded). Reset to empty only when
// debug mode is off, so turning it back on re-fetches everything that
// accumulated while the panel wasn't polling instead of silently skipping it.
let lastEntries = [];
let lastSeenId = 0;

// #315: debug mode off → the shared empty state with an Open settings action.
function showDebugOffState(list) {
  list.replaceChildren(renderEmptyState({
    icon: 'bug', tone: 'neutral', title: 'Debug log',
    text: "TesterBrowser's own internal logs. Turn on Debug mode to collect them.",
    actionLabel: 'Open settings', onAction: () => { openSettings(); },
  }));
}

// Level filter: a single-choice segmented control. "All" shows every level,
// including info, which has no segment of its own.
let levelFilter = 'all';
let sourceFilter = '';

export async function initDebugLog() {
  if (!initialized) {
    initialized = true;
    document.getElementById('debugLogPanel').innerHTML = `
      <div id="debugLogControls">
        <label class="net-search"><i class="icon-search" aria-hidden="true"></i>
          <input id="debugLogFilterText" placeholder="Filter log" aria-label="Filter log" /></label>
        <div class="seg" id="debugLogLevelPills" role="group" aria-label="Level">
          <button class="seg-btn on" data-level="all" aria-pressed="true">All<span class="pill-count"></span></button>
          <button class="seg-btn" data-level="error" aria-pressed="false">Errors<span class="pill-count"></span></button>
          <button class="seg-btn" data-level="warn" aria-pressed="false">Warnings<span class="pill-count"></span></button>
          <button class="seg-btn" data-level="debug" aria-pressed="false">Debug<span class="pill-count"></span></button>
        </div>
        <div class="debuglog-sources" id="debugLogSources" role="group" aria-label="Source"></div>
        <span class="net-spacer"></span>
        <select id="debugLogSessionFilter" title="Filter by session"><option value="">All sessions</option></select>
        <button class="net-chip" id="copyDebugLogBtn" type="button" title="Copy debug log to clipboard"><i class="icon-copy" aria-hidden="true"></i>Copy</button>
      </div>
      <div class="debuglog-wrap"><div id="debugLogList" class="debuglog-list"></div></div>`;

    document.querySelectorAll('#debugLogLevelPills .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        levelFilter = /** @type {HTMLElement} */ (btn).dataset.level;
        document.querySelectorAll('#debugLogLevelPills .seg-btn').forEach((b) => {
          const on = /** @type {HTMLElement} */ (b).dataset.level === levelFilter;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
        });
        renderDebugLog();
      });
    });
    // Source chips are added as new sources appear (see syncFilterOptions);
    // clicking the active one clears the filter.
    document.getElementById('debugLogSources').addEventListener('click', (e) => {
      const chip = /** @type {HTMLElement} */ (e.target).closest('.debuglog-source-chip');
      if (!chip) return;
      sourceFilter = sourceFilter === chip.dataset.source ? '' : chip.dataset.source;
      syncSourceChips();
      renderDebugLog();
    });
    /** @type {HTMLInputElement} */ (document.getElementById('debugLogFilterText')).addEventListener('input', renderDebugLog);
    /** @type {HTMLSelectElement} */ (document.getElementById('debugLogSessionFilter')).addEventListener('change', renderDebugLog);
    document.getElementById('copyDebugLogBtn').addEventListener('click', copyDebugLog);
    // Delegated so newly-appended rows (poll ticks never touch existing
    // DOM — see pollDebugLog()) don't need their own listener wired up.
    document.getElementById('debugLogList').addEventListener('click', (e) => {
      const row = /** @type {HTMLElement} */ (e.target).closest('.debuglog-row.has-ctx');
      if (row) row.closest('.debuglog-entry').classList.toggle('expanded');
    });
    // #254: started once, ever — pollWhileVisible checks isVisible() fresh
    // before every tick, so there's no need to stop/restart it on every
    // switch to/from the Debug Log tab the way the old setInterval did.
    pollWhileVisible(pollDebugLog, 1000, () => getActiveConsoleTab() === 'debuglog');
  }
  await pollDebugLog(); // immediate refresh on switching to this tab, not up to 1s stale
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
    showDebugOffState(list);
    return;
  }

  controls.style.display = 'flex';
  // Switching debug mode back on replaces the empty state with the list.
  if (list.querySelector('.empty-state')) list.innerHTML = '';
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
  const sourceBox = document.getElementById('debugLogSources');
  const sessionSelect = /** @type {HTMLSelectElement} */ (document.getElementById('debugLogSessionFilter'));
  const knownSources = new Set([...sourceBox.querySelectorAll('.debuglog-source-chip')].map((c) => /** @type {HTMLElement} */ (c).dataset.source));
  const knownSessions = new Set([...sessionSelect.options].map((o) => o.value).filter(Boolean));

  for (const e of lastEntries) {
    if (e.source && !knownSources.has(e.source)) {
      knownSources.add(e.source);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'debuglog-source-chip';
      chip.dataset.source = e.source;
      chip.textContent = e.source;
      chip.setAttribute('aria-pressed', 'false');
      sourceBox.appendChild(chip);
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

function syncSourceChips() {
  document.querySelectorAll('#debugLogSources .debuglog-source-chip').forEach((c) => {
    const on = /** @type {HTMLElement} */ (c).dataset.source === sourceFilter;
    c.classList.toggle('on', on);
    c.setAttribute('aria-pressed', String(on));
  });
}

function getSessionLabel(sessionId) {
  if (!sessionId) return '';
  let nameEl = null;
  try { nameEl = document.querySelector(`.tab[data-id="${CSS.escape(sessionId)}"] .tab-name`); } catch {}
  if (nameEl) return nameEl.textContent;
  return sessionId.slice(0, 8);
}

function currentFilters() {
  const sessionId = /** @type {HTMLSelectElement} */ (document.getElementById('debugLogSessionFilter')).value;
  const filterText = /** @type {HTMLInputElement} */ (document.getElementById('debugLogFilterText')).value;
  return { level: levelFilter, source: sourceFilter, sessionId, filterText };
}

function matchesFilters(e, f) {
  if (f.level !== 'all' && e.level !== f.level) return false;
  if (f.source && e.source !== f.source) return false;
  if (f.sessionId && e.sessionId !== f.sessionId) return false;
  const haystack = `${e.message} ${e.source} ${e.ctx ? JSON.stringify(e.ctx) : ''}`;
  return matchesFreeText(haystack, f.filterText);
}

function updatePillCounts() {
  document.querySelectorAll('#debugLogLevelPills .seg-btn').forEach((btn) => {
    const lvl = /** @type {HTMLElement} */ (btn).dataset.level;
    const n = lvl === 'all' ? lastEntries.length : lastEntries.filter((e) => e.level === lvl).length;
    const span = btn.querySelector('.pill-count');
    if (span) span.textContent = n > 0 ? String(n) : '';
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
    <div class="debuglog-entry debuglog-entry-${e.level}" data-id="${e.id ?? ''}">
      <div class="debuglog-row${hasCtx ? ' has-ctx' : ''}"${sessionLabel ? ` title="Session: ${escHtml(sessionLabel)}"` : ''}>
        <span class="debuglog-ts">${new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
        <span class="debuglog-level debuglog-level-${e.level}">${e.level}</span>
        <span class="debuglog-source">${escHtml(e.source || 'app')}</span>
        <span class="debuglog-msg">${escHtml(e.message)}${sessionLabel ? ` <span class="debuglog-session">\u00b7 ${escHtml(sessionLabel)}</span>` : ''}</span>
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
  const prev = btn.innerHTML;
  btn.innerHTML = '<i class="icon-check" aria-hidden="true"></i>Copied';
  setTimeout(() => { btn.innerHTML = prev; }, 1500);
}

function formatEntryForCopy(e) {
  const session = e.sessionId ? ` (${getSessionLabel(e.sessionId)})` : '';
  const ctx = e.ctx && Object.keys(e.ctx).length > 0 ? ` ${JSON.stringify(e.ctx)}` : '';
  return `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase()} [${e.source || 'app'}]${session} ${e.message}${ctx}`;
}
