/* global testerBrowser */
import { initModal, openModal, closeModal } from './modal.js';

let pendingSessionId = null;

// Shared by the context-menu-driven testdata:promptTemplate IPC event and
// the app-menu's own "Fill with test data…" item (#244) — both need the
// same open behaviour, including hiding the active tab's WebContentsView
// first, since it paints above this overlay's HTML regardless of z-index
// (see CLAUDE.md's "Renderer: console panel" notes; every other modal in
// the app — bugreport.js, crash-report.js, notes.js, replay.js — does this).
export async function openTestdataModal(sessionId) {
  pendingSessionId = sessionId;
  document.getElementById('testdataInput').value = '';
  await openModal('testdataOverlay', () => {
    setTimeout(() => document.getElementById('testdataInput').focus(), 50);
  });
}

async function close() {
  await closeModal('testdataOverlay');
  pendingSessionId = null;
}

export function initTestdata() {
  const input      = document.getElementById('testdataInput');
  const fillBtn    = document.getElementById('testdataFillBtn');
  const cancelBtn  = document.getElementById('testdataCancelBtn');
  const closeXBtn  = document.getElementById('testdataCloseXBtn');

  initModal('testdataOverlay', close);
  testerBrowser.testdata.onPromptTemplate(({ sessionId }) => openTestdataModal(sessionId));

  fillBtn.addEventListener('click', applyTemplate);
  cancelBtn.addEventListener('click', close);
  closeXBtn.addEventListener('click', close);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') applyTemplate();
  });

  function applyTemplate() {
    const tpl = input.value.trim();
    if (!tpl || !pendingSessionId) { close(); return; }
    testerBrowser.testdata.apply(pendingSessionId, tpl);
    close();
  }
}
