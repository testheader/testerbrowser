/* global testerBrowser */

// notesSessionId (which session's notes overlay is open, if any) is entirely
// private to this file — nothing else reads or writes it.
let notesSessionId = null;
// #268: what openNotes() loaded into the textarea, so a close attempt can
// tell whether anything was actually typed since — comparing against the
// live session's saved notes wouldn't work, since Save doesn't touch that
// until the modal is already closing.
let loadedText = '';

export async function openNotes(id) {
  notesSessionId = id;
  const sessions = await testerBrowser.sessions.list();
  const s = sessions.find((x) => x.id === id);
  document.getElementById('notesTitle').textContent = 'Notes — ' + (s?.name || id);
  loadedText = await testerBrowser.sessions.getNotes(id);
  document.getElementById('notesTextarea').value = loadedText;
  hideDiscardConfirm();
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('notesOverlay').classList.add('open');
  document.getElementById('notesTextarea').focus();
}

function hasUnsavedChanges() {
  return document.getElementById('notesTextarea').value !== loadedText;
}

function showDiscardConfirm() {
  document.getElementById('notesActions').hidden = true;
  document.getElementById('notesDiscardConfirm').hidden = false;
}

function hideDiscardConfirm() {
  document.getElementById('notesDiscardConfirm').hidden = true;
  document.getElementById('notesActions').hidden = false;
}

async function closeNotes() {
  document.getElementById('notesOverlay').classList.remove('open');
  await testerBrowser.layout.setViewerVisible(true);
  notesSessionId = null;
}

// Esc, the backdrop, the × button and the Close button all funnel through
// here rather than calling closeNotes() directly — unlike Save, none of them
// otherwise know the textarea has drifted from what was loaded.
async function requestClose() {
  if (hasUnsavedChanges()) { showDiscardConfirm(); return; }
  await closeNotes();
}

export function initNotes() {
  document.getElementById('saveNotesBtn').onclick  = async () => {
    if (notesSessionId) {
      await testerBrowser.sessions.setNotes(notesSessionId, document.getElementById('notesTextarea').value);
    }
    await closeNotes();
  };
  document.getElementById('closeNotesBtn').onclick  = () => requestClose();
  document.getElementById('notesCloseXBtn').onclick = () => requestClose();
  document.getElementById('notesOverlay').onclick  = (e) => {
    if (e.target === document.getElementById('notesOverlay')) requestClose();
  };
  document.getElementById('notesKeepEditingBtn').onclick = () => hideDiscardConfirm();
  document.getElementById('notesDiscardBtn').onclick     = () => closeNotes();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('notesOverlay').classList.contains('open')) requestClose();
  });
}
