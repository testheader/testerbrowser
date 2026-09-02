/* global testerBrowser */
import { state, TOPBAR_BASE, FIND_BAR_H, BOOKMARKS_BAR_H } from './state.js';

const CONSOLE_HEADER_H = 42; // drag handle (6px) + header (36px)
const LS_MIN_KEY = 'consoleMinimized';

function applyMinimized(minimized) {
  state.consolePanelMinimized = minimized;
  const body = document.getElementById('consolePanelBody');
  const btn  = document.getElementById('consolePanelMinBtn');
  const panel = document.getElementById('consolePanel');
  body.style.display = minimized ? 'none' : '';
  btn.innerHTML = minimized ? '&#8963;' : '&#8964;';
  btn.title = minimized ? 'Restore panel' : 'Minimize panel';
  if (minimized) {
    panel.style.height = CONSOLE_HEADER_H + 'px';
    testerBrowser.layout.setConsoleHeight(0);
  } else {
    panel.style.height = state.consoleHeight + 'px';
    testerBrowser.layout.setConsoleHeight(state.consoleHeight);
  }
  try { localStorage.setItem(LS_MIN_KEY, minimized ? '1' : '0'); } catch {}
}

export function initMinimize() {
  try {
    const saved = localStorage.getItem(LS_MIN_KEY);
    if (saved === '1') applyMinimized(true);
  } catch {}
  document.getElementById('consolePanelMinBtn').addEventListener('click', () => {
    applyMinimized(!state.consolePanelMinimized);
  });
}

export function updateTopBarHeight() {
  let h = TOPBAR_BASE;
  if (state.bookmarksBarVisible) h += BOOKMARKS_BAR_H;
  if (state.findOpen) h += FIND_BAR_H;
  testerBrowser.layout.setTopBarHeight(h);
  document.getElementById('downloadsPanel').style.top          = h + 'px';
  document.getElementById('permissionNotifications').style.top = h + 'px';
}

function currentTopBarHeight() {
  let h = TOPBAR_BASE;
  if (state.bookmarksBarVisible) h += BOOKMARKS_BAR_H;
  if (state.findOpen) h += FIND_BAR_H;
  return h;
}

export function setConsoleHeight(h) {
  const maxH = window.innerHeight - currentTopBarHeight() - 80;
  state.consoleHeight = Math.max(80, Math.min(h, maxH));
  if (!state.consolePanelMinimized) {
    document.getElementById('consolePanel').style.height = state.consoleHeight + 'px';
    testerBrowser.layout.setConsoleHeight(state.consoleHeight);
  }
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
