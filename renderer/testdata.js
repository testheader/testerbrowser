/* global testerBrowser */

let pendingSessionId = null;

export function initTestdata() {
  const overlay    = document.getElementById('testdataOverlay');
  const input      = document.getElementById('testdataInput');
  const fillBtn    = document.getElementById('testdataFillBtn');
  const cancelBtn  = document.getElementById('testdataCancelBtn');
  const closeXBtn  = document.getElementById('testdataCloseXBtn');

  testerBrowser.testdata.onPromptTemplate(({ sessionId }) => {
    pendingSessionId = sessionId;
    input.value = '';
    overlay.classList.add('open');
    setTimeout(() => input.focus(), 50);
  });

  fillBtn.addEventListener('click', applyTemplate);
  cancelBtn.addEventListener('click', close);
  closeXBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') applyTemplate();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });

  function applyTemplate() {
    const tpl = input.value.trim();
    if (!tpl || !pendingSessionId) { close(); return; }
    testerBrowser.testdata.apply(pendingSessionId, tpl);
    close();
  }

  function close() {
    overlay.classList.remove('open');
    pendingSessionId = null;
  }
}
