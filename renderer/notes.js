/* global testerBrowser */
import { state } from './state.js';

export async function openNotes(id) {
  state.notesSessionId = id;
  const sessions = await testerBrowser.sessions.list();
  const s = sessions.find((x) => x.id === id);
  document.getElementById('notesTitle').textContent    = 'Notes — ' + (s?.name || id);
  document.getElementById('notesTextarea').value       = await testerBrowser.sessions.getNotes(id);
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('notesOverlay').classList.add('open');
  document.getElementById('notesTextarea').focus();
}

async function closeNotes() {
  document.getElementById('notesOverlay').classList.remove('open');
  await testerBrowser.layout.setViewerVisible(true);
  state.notesSessionId = null;
}

export function initNotes() {
  document.getElementById('saveNotesBtn').onclick  = async () => {
    if (state.notesSessionId) {
      await testerBrowser.sessions.setNotes(state.notesSessionId, document.getElementById('notesTextarea').value);
    }
    closeNotes();
  };
  document.getElementById('closeNotesBtn').onclick  = () => closeNotes();
  document.getElementById('notesCloseXBtn').onclick = () => closeNotes();
  document.getElementById('notesOverlay').onclick  = (e) => {
    if (e.target === document.getElementById('notesOverlay')) closeNotes();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('notesOverlay').classList.contains('open')) closeNotes();
  });
}
