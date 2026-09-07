/* global testerBrowser */
import { isFindOpen, setFindOpen } from './layout.js';
import { getActiveId } from './tabs.js';

let findText = '';

export function openFind() {
  if (!isFindOpen()) {
    setFindOpen(true);
    document.getElementById('findBar').classList.add('open');
  }
  const fi = document.getElementById('findInput');
  fi.focus(); fi.select();
}

export function closeFind() {
  if (!isFindOpen()) return;
  setFindOpen(false);
  document.getElementById('findBar').classList.remove('open');
  document.getElementById('findInput').classList.remove('no-match');
  document.getElementById('findCount').textContent = '';
  const activeId = getActiveId();
  if (activeId) testerBrowser.sessions.stopFind(activeId);
}

export function doFind(forward, next) {
  const activeId = getActiveId();
  if (!activeId || !findText) return;
  testerBrowser.sessions.findInPage(activeId, findText, forward, next);
}

export function initFind() {
  const findInput = document.getElementById('findInput');

  findInput.addEventListener('input', () => {
    findText = findInput.value;
    if (findText) doFind(true, false);
    else {
      document.getElementById('findCount').textContent = '';
      if (getActiveId()) testerBrowser.sessions.stopFind(getActiveId());
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
    if (id !== getActiveId()) return;
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
