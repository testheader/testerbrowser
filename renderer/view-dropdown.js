/* global testerBrowser */
import { state } from './state.js';
import { toggleBookmarksBar } from './bookmarks.js';
import { syncConsoleViewHeight } from './layout.js';

function updateViewDropdown() {
  document.getElementById('viewConsoleCheck').textContent   = state.consoleVisible      ? '✓' : '';
  document.getElementById('viewBookmarksCheck').textContent = state.bookmarksBarVisible ? '✓' : '';
}

function openViewDropdown() {
  const dd = document.getElementById('viewDropdown');
  if (dd.classList.contains('open')) return;
  dd.classList.add('open');
  updateViewDropdown();
  testerBrowser.layout.setViewerVisible(false);
}

function closeViewDropdown() {
  const dd = document.getElementById('viewDropdown');
  if (!dd.classList.contains('open')) return;
  dd.classList.remove('open');
  testerBrowser.layout.setViewerVisible(true);
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
