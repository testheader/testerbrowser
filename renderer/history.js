/* global testerBrowser */
import { switchToSession } from './tabs.js';
import { escHtml } from './utils.js';
import { initModal, openModal, closeModal } from './modal.js';

// historySessionId (which session's history overlay is open, if any) is
// entirely private to this file — nothing else reads or writes it.
let historySessionId = null;

export async function openHistory(id) {
  historySessionId = id;
  const sessions = await testerBrowser.sessions.list();
  const s = sessions.find((x) => x.id === id);
  document.getElementById('historyTitle').textContent = 'History — ' + (s?.name || id);
  await renderHistoryList(id);
  await openModal('historyOverlay');
}

async function renderHistoryList(id) {
  const list = document.getElementById('historyList');
  const entries = await testerBrowser.sessions.getHistory(id);
  if (entries.length === 0) {
    list.innerHTML = '<div class="history-empty">No history yet for this session.</div>';
    return;
  }
  list.innerHTML = entries.map((e) => `
    <button class="history-entry${e.failed ? ' history-entry-failed' : ''}" data-url="${escHtml(e.url)}" title="${escHtml(e.url)}">
      <span class="history-entry-url">${escHtml(e.url)}</span>
      <span class="history-entry-ts">${escHtml(new Date(e.ts).toLocaleString())}</span>
    </button>
  `).join('');
}

async function closeHistory() {
  await closeModal('historyOverlay');
  historySessionId = null;
}

export function initHistory() {
  initModal('historyOverlay', closeHistory);
  document.getElementById('closeHistoryBtn').onclick  = () => closeHistory();
  document.getElementById('historyCloseXBtn').onclick = () => closeHistory();
  document.getElementById('historyList').addEventListener('click', async (e) => {
    const entry = e.target.closest('.history-entry');
    if (!entry || !historySessionId) return;
    const sessionId = historySessionId;
    await testerBrowser.sessions.navigate(sessionId, entry.dataset.url);
    await switchToSession(sessionId);
    closeHistory();
  });
}
