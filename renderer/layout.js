/* global testerBrowser */
import { TOPBAR_BASE, FIND_BAR_H, BOOKMARKS_BAR_H } from './state.js';

const CONSOLE_HEADER_H = 42; // drag handle (6px) + header (36px)
const LS_MIN_KEY = 'consoleMinimized';

// Layout owns every pure visibility/dimension flag that feeds the topbar and
// console-panel height math (findOpen, bookmarksBarVisible, consoleVisible,
// consolePanelMinimized, consoleHeight) — the feature modules that toggle
// them (find.js, bookmarks.js, view-dropdown.js) already depend one-way on
// this module for the height recompute that follows every toggle, so they
// go through the setters below instead of touching layout state directly.
let consoleHeight         = 220;
let consolePanelMinimized = false;
let consoleVisible        = true;
let findOpen               = false;
let bookmarksBarVisible    = false;
let permissionBarHeight    = 0;

export function getConsoleHeight() { return consoleHeight; }

export function isFindOpen() { return findOpen; }
export function setFindOpen(open) {
  findOpen = open;
  updateTopBarHeight();
}

export function isBookmarksBarVisible() { return bookmarksBarVisible; }
export function toggleBookmarksBarVisible() {
  bookmarksBarVisible = !bookmarksBarVisible;
  updateTopBarHeight();
  return bookmarksBarVisible;
}

export function isConsoleVisible() { return consoleVisible; }
export function toggleConsoleVisible() {
  consoleVisible = !consoleVisible;
  document.getElementById('consolePanel').style.display = consoleVisible ? 'flex' : 'none';
  syncConsoleViewHeight();
  return consoleVisible;
}

function applyMinimized(minimized) {
  consolePanelMinimized = minimized;
  const body = document.getElementById('consolePanelBody');
  const btn  = document.getElementById('consolePanelMinBtn');
  const panel = document.getElementById('consolePanel');
  body.style.display = minimized ? 'none' : '';
  btn.innerHTML = minimized ? '&#8963;' : '&#8964;';
  btn.title = minimized ? 'Restore panel' : 'Minimize panel';
  panel.style.height = (minimized ? CONSOLE_HEADER_H : consoleHeight) + 'px';
  syncConsoleViewHeight();
  try { localStorage.setItem(LS_MIN_KEY, minimized ? '1' : '0'); } catch {}
}

// Single source of truth for how tall the BrowserView thinks the console panel
// is: hidden (via View ▾) has nothing to show, so it collapses to 0. Minimized
// (via the panel's own button) still renders a real, always-visible header bar,
// so the BrowserView must leave room for it instead of painting over it.
export function syncConsoleViewHeight() {
  const h = !consoleVisible ? 0 : consolePanelMinimized ? CONSOLE_HEADER_H : consoleHeight;
  testerBrowser.layout.setConsoleHeight(h);
}

export function initMinimize() {
  try {
    const saved = localStorage.getItem(LS_MIN_KEY);
    if (saved === '1') applyMinimized(true);
  } catch {}
  document.getElementById('consolePanelMinBtn').addEventListener('click', () => {
    applyMinimized(!consolePanelMinimized);
  });
}

// Reserves real BrowserView-bounds space above the tab content for pending
// permission notifications. They're rendered as normal DOM (position: fixed)
// in the renderer window, but the BrowserView is a separate native layer
// always painted on top of that DOM — z-index can't lift them above it, so
// the only way to make them visible is to push the BrowserView's top edge
// down past them.
export function setPermissionBarHeight(h) {
  permissionBarHeight = h;
  updateTopBarHeight();
}

export function updateTopBarHeight() {
  let h = TOPBAR_BASE;
  if (bookmarksBarVisible) h += BOOKMARKS_BAR_H;
  if (findOpen) h += FIND_BAR_H;
  testerBrowser.layout.setTopBarHeight(h + permissionBarHeight);
  document.getElementById('downloadsPanel').style.top          = h + 'px';
  document.getElementById('permissionNotifications').style.top = h + 'px';
}

export function currentTopBarHeight() {
  let h = TOPBAR_BASE;
  if (bookmarksBarVisible) h += BOOKMARKS_BAR_H;
  if (findOpen) h += FIND_BAR_H;
  return h + permissionBarHeight;
}

export function setConsoleHeight(h) {
  const maxH = window.innerHeight - currentTopBarHeight() - 80;
  consoleHeight = Math.max(80, Math.min(h, maxH));
  if (!consolePanelMinimized) {
    document.getElementById('consolePanel').style.height = consoleHeight + 'px';
    syncConsoleViewHeight();
  }
}

export function initLayout() {
  const handle = document.getElementById('consoleDragHandle');
  let preSnapHeight = null;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = consoleHeight;
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

  handle.addEventListener('dblclick', () => {
    if (consolePanelMinimized) return;
    if (preSnapHeight !== null) {
      setConsoleHeight(preSnapHeight);
      preSnapHeight = null;
    } else {
      preSnapHeight = consoleHeight;
      setConsoleHeight(Math.round(window.innerHeight * 0.33));
    }
  });
}
