/* global testerBrowser */
import { state } from './state.js';
import { updateTopBarHeight } from './layout.js';

let findText = '';

export function openFind() {
  if (!state.findOpen) {
    state.findOpen = true;
    document.getElementById('findBar').classList.add('open');
    updateTopBarHeight();
  }
  const fi = document.getElementById('findInput');
  fi.focus(); fi.select();
}

export function closeFind() {
  if (!state.findOpen) return;
  state.findOpen = false;
  document.getElementById('findBar').classList.remove('open');
  document.getElementById('findInput').classList.remove('no-match');
  document.getElementById('findCount').textContent = '';
  updateTopBarHeight();
  if (state.activeId) testerBrowser.sessions.stopFind(state.activeId);
}

export function doFind(forward, next) {
  if (!state.activeId || !findText) return;
  testerBrowser.sessions.findInPage(state.activeId, findText, forward, next);
}

export function initFind() {
  const findInput = document.getElementById('findInput');

  findInput.addEventListener('input', () => {
    findText = findInput.value;
    if (findText) doFind(true, false);
    else {
      document.getElementById('findCount').textContent = '';
      if (state.activeId) testerBrowser.sessions.stopFind(state.activeId);
    }
  });

  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); doFind(!e.shiftKey, true); }
    if (e.key === 'Escape') closeFind();
  });

  document.getElementById('findPrevBtn').onclick  = () => doFind(false, true);
  document.getElementById('findNextBtn').onclick  = () => doFind(true,  true);
  document.getElementById('findCloseBtn').onclick = () => closeFind();

  testerBrowser.sessions.onFindResult(({ id, matches, activeMatch }) => {
    if (id !== state.activeId) return;
    const count = document.getElementById('findCount');
    if (matches === 0) {
      count.textContent = 'No results';
      findInput.classList.add('no-match');
    } else {
      count.textContent = `${activeMatch}/${matches}`;
      findInput.classList.remove('no-match');
    }
  });
}
