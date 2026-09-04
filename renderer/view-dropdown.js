/* global testerBrowser */
import { state } from './state.js';
import { toggleBookmarksBar } from './bookmarks.js';
import { syncConsoleViewHeight, currentTopBarHeight } from './layout.js';

function updateViewDropdown() {
  document.getElementById('viewConsoleCheck').textContent   = state.consoleVisible      ? '✓' : '';
  document.getElementById('viewBookmarksCheck').textContent = state.bookmarksBarVisible ? '✓' : '';
}

function openViewDropdown() {
  const dd = document.getElementById('viewDropdown');
  if (dd.classList.contains('open')) return;
  dd.classList.add('open');
  updateViewDropdown();
  // The dropdown can extend below the topbar into the region the native
  // WebContentsView paints over — push the view down to clear it instead of
  // detaching the whole view, so the rest of the page keeps rendering.
  const inset = Math.max(0, dd.getBoundingClientRect().bottom - currentTopBarHeight());
  testerBrowser.layout.setTopInset(inset);
}

function closeViewDropdown() {
  const dd = document.getElementById('viewDropdown');
  if (!dd.classList.contains('open')) return;
  dd.classList.remove('open');
  testerBrowser.layout.setTopInset(0);
}

export function initViewDropdown() {
  const viewWrapper = document.getElementById('viewWrapper');

  document.getElementById('viewBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('viewDropdown').classList.contains('open')
      ? closeViewDropdown()
      : openViewDropdown();
  });

  document.addEventListener('click', (e) => {
    if (!viewWrapper.contains(e.target)) closeViewDropdown();
  });

  document.getElementById('viewToggleConsole').addEventListener('click', () => {
    state.consoleVisible = !state.consoleVisible;
    document.getElementById('consolePanel').style.display = state.consoleVisible ? 'flex' : 'none';
    syncConsoleViewHeight();
    updateViewDropdown();
    closeViewDropdown();
  });

  document.getElementById('viewToggleBookmarks').addEventListener('click', () => {
    toggleBookmarksBar();
    updateViewDropdown();
    closeViewDropdown();
  });
}
