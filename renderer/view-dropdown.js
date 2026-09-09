import { toggleBookmarksBar } from './bookmarks.js';
import { isConsoleVisible, toggleConsoleVisible, isBookmarksBarVisible, beginPageOverlay, endPageOverlay } from './layout.js';
import { closeAppMenu } from './app-menu.js';

function updateViewDropdown() {
  document.getElementById('viewConsoleCheck').textContent   = isConsoleVisible()      ? '✓' : '';
  document.getElementById('viewBookmarksCheck').textContent = isBookmarksBarVisible() ? '✓' : '';
}

function openViewDropdown() {
  const dd = document.getElementById('viewDropdown');
  if (dd.classList.contains('open')) return;
  closeAppMenu();
  dd.classList.add('open');
  updateViewDropdown();
  // The dropdown can extend below the topbar into the region the native view
  // paints over — snapshot the page and detach the view while it's open (see
  // layout.js beginPageOverlay) instead of pushing the view down, which used
  // to shove the whole page out of place.
  beginPageOverlay();
}

export function closeViewDropdown() {
  const dd = document.getElementById('viewDropdown');
  if (!dd.classList.contains('open')) return;
  dd.classList.remove('open');
  endPageOverlay();
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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeViewDropdown();
  });

  document.getElementById('viewToggleConsole').addEventListener('click', () => {
    toggleConsoleVisible();
    updateViewDropdown();
    closeViewDropdown();
  });

  document.getElementById('viewToggleBookmarks').addEventListener('click', () => {
    toggleBookmarksBar();
    updateViewDropdown();
    closeViewDropdown();
  });
}
