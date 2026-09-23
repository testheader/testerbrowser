/* global testerBrowser */
import { escHtml, wirePillGroup, activePillValues, matchesFreeText } from './utils.js';

let initialized = false;
let pollHandle = null;
let lastEntries = [];

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
        <button class="console-icon-btn" id="copyDebugLogBtn" title="Copy debug log to clipboard">&#128203;</button>
      </div>
      <div class="debuglog-wrap"><div id="debugLogList" class="debuglog-list"></div></div>`;

    wirePillGroup(document.getElementById('debugLogLevelPills'), renderDebugLog);
    document.getElementById('debugLogFilterText').addEventListener('input', renderDebugLog);
    document.getElementById('copyDebugLogBtn').addEventListener('click', copyDebugLog);
  }
  await refreshDebugLog();
  stopDebugLogPolling();
  pollHandle = setInterval(refreshDebugLog, 1000);
}

export function stopDebugLogPolling() {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
}

async function refreshDebugLog() {
  const controls = document.getElementById('debugLogControls');
  const list = document.getElementById('debugLogList');
  if (!list) return;

  const settings = await testerBrowser.settings.get();
  if (!settings.debugMode) {
    controls.style.display = 'none';
    lastEntries = [];
    list.innerHTML = `<div class="debuglog-empty">${escHtml(EMPTY_STATE_OFF)}</div>`;
    return;
  }

  controls.style.display = 'flex';
  lastEntries = await testerBrowser.app.getDebugLog();
  renderDebugLog();
}

function renderDebugLog() {
  const list = document.getElementById('debugLogList');
  if (!list) return;

  document.querySelectorAll('#debugLogLevelPills .filter-pill').forEach((btn) => {
    const n = lastEntries.filter((e) => e.level === btn.dataset.level).length;
    const span = btn.querySelector('.pill-count');
    if (span) span.textContent = n > 0 ? n : '';
  });

  if (!lastEntries.length) {
    list.innerHTML = '<div class="debuglog-empty">No internal errors logged yet.</div>';
    return;
  }

  const activeLevels = activePillValues(document.getElementById('debugLogLevelPills'), 'level');
  const filterText = document.getElementById('debugLogFilterText').value;
  const filtered = lastEntries.filter((e) => activeLevels.has(e.level) && matchesFreeText(e.message, filterText));

  if (!filtered.length) {
    list.innerHTML = '<div class="debuglog-empty">No entries match the current filter.</div>';
    return;
  }

  list.innerHTML = filtered.map((e) => `
    <div class="debuglog-row">
      <span class="debuglog-level debuglog-level-${e.level}">${e.level}</span>
      <span class="debuglog-ts">${new Date(e.ts).toLocaleTimeString()}</span>
      <span class="debuglog-msg">${escHtml(e.message)}</span>
    </div>`).join('');
}

async function copyDebugLog() {
  const text = lastEntries.length
    ? lastEntries.map((e) => `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase()}: ${e.message}`).join('\n')
    : 'No internal errors logged yet.';
  await testerBrowser.clipboard.write(text);
  const btn = document.getElementById('copyDebugLogBtn');
  const prev = btn.textContent;
  btn.textContent = '✓';
  setTimeout(() => { btn.textContent = prev; }, 1500);
}
