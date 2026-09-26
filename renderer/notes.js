/* global testerBrowser */
import { initModal, requestClose, openModal, closeModal } from './modal.js';

// notesSessionId (which session's notes overlay is open, if any) is entirely
// private to this file — nothing else reads or writes it.
let notesSessionId = null;
// #268: what openNotes() loaded into the textarea, so a close attempt can
// tell whether anything was actually typed since — comparing against the
// live session's saved notes wouldn't work, since Save doesn't touch that
// until the modal is already closing.
let loadedText = '';
// Resolved by the Discard/Keep-editing buttons below, while confirmClose()
// (passed to modal.js's initModal()) has one pending.
let pendingDiscardResolve = null;

export async function openNotes(id) {
  notesSessionId = id;
  const sessions = await testerBrowser.sessions.list();
  const s = sessions.find((x) => x.id === id);
  document.getElementById('notesTitle').textContent = 'Notes — ' + (s?.name || id);
  loadedText = await testerBrowser.sessions.getNotes(id);
  document.getElementById('notesTextarea').value = loadedText;
  hideDiscardConfirm();
  await openModal('notesOverlay', () => document.getElementById('notesTextarea').focus());
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
  await closeModal('notesOverlay');
  notesSessionId = null;
}

// #268/#254: modal.js's initModal() calls this before honoring Esc, the
// backdrop, or the × / Close buttons — none of those otherwise know the
// textarea has drifted from what was loaded. Resolves once the tester picks
// Discard (proceed — true) or Keep editing (veto — false) below.
function confirmClose() {
  if (!hasUnsavedChanges()) return true;
  showDiscardConfirm();
  return new Promise((resolve) => { pendingDiscardResolve = resolve; });
}

export function initNotes() {
  initModal('notesOverlay', closeNotes, { confirmClose });

  document.getElementById('saveNotesBtn').onclick  = async () => {
    if (notesSessionId) {
      await testerBrowser.sessions.setNotes(notesSessionId, document.getElementById('notesTextarea').value);
    }
    await closeNotes();
  };
  document.getElementById('closeNotesBtn').onclick  = () => requestClose('notesOverlay');
  document.getElementById('notesCloseXBtn').onclick = () => requestClose('notesOverlay');
  document.getElementById('notesKeepEditingBtn').onclick = () => {
    hideDiscardConfirm();
    pendingDiscardResolve?.(false);
    pendingDiscardResolve = null;
  };
  document.getElementById('notesDiscardBtn').onclick = () => {
    pendingDiscardResolve?.(true);
    pendingDiscardResolve = null;
  };
}
