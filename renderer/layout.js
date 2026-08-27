/* global testerBrowser */
import { state, TOPBAR_BASE, FIND_BAR_H, BOOKMARKS_BAR_H } from './state.js';

export function updateTopBarHeight() {
  let h = TOPBAR_BASE;
  if (state.bookmarksBarVisible) h += BOOKMARKS_BAR_H;
  if (state.findOpen) h += FIND_BAR_H;
  testerBrowser.layout.setTopBarHeight(h);
  document.getElementById('downloadsPanel').style.top          = h + 'px';
  document.getElementById('permissionNotifications').style.top = h + 'px';
}

export function setConsoleHeight(h) {
  state.consoleHeight = Math.max(80, Math.min(h, window.innerHeight - 120));
  document.getElementById('consolePanel').style.height = state.consoleHeight + 'px';
  testerBrowser.layout.setConsoleHeight(state.consoleHeight);
}

export function initLayout() {
  const handle = document.getElementById('consoleDragHandle');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = state.consoleHeight;
    handle.classList.add('dragging');
    const onMove = (ev) => setConsoleHeight(startH + (startY - ev.clientY));
    const onUp   = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}
