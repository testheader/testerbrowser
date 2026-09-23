/* global testerBrowser */
import { escHtml } from './utils.js';

let initialized = false;
let pollHandle = null;

const EMPTY_STATE_OFF =
  'Debug mode is off — enable it in Settings → General to see TesterBrowser\'s own internal logs';

export async function initDebugLog() {
  if (!initialized) {
    initialized = true;
    document.getElementById('debugLogPanel').innerHTML =
      '<div class="debuglog-wrap"><div id="debugLogList" class="debuglog-list"></div></div>';
  }
  await refreshDebugLog();
  stopDebugLogPolling();
  pollHandle = setInterval(refreshDebugLog, 1000);
}

export function stopDebugLogPolling() {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
}

async function refreshDebugLog() {
  const list = document.getElementById('debugLogList');
  if (!list) return;

  const settings = await testerBrowser.settings.get();
  if (!settings.debugMode) {
    list.innerHTML = `<div class="debuglog-empty">${escHtml(EMPTY_STATE_OFF)}</div>`;
    return;
  }

  const entries = await testerBrowser.app.getDebugLog();
  if (!entries.length) {
    list.innerHTML = '<div class="debuglog-empty">No internal errors logged yet.</div>';
    return;
  }

  list.innerHTML = entries.map(e => `
    <div class="debuglog-row">
      <span class="debuglog-ts">${new Date(e.ts).toLocaleTimeString()}</span>
      <span class="debuglog-msg">${escHtml(e.message)}</span>
    </div>`).join('');
}
