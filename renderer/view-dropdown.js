/* global testerBrowser */
import { toggleBookmarksBar } from './bookmarks.js';
import { isConsoleVisible, toggleConsoleVisible, isBookmarksBarVisible, beginPageOverlay, endPageOverlay } from './layout.js';
import { closeAppMenu } from './app-menu.js';
import { getActiveId } from './tabs.js';
import { openSettings } from './settings.js';

function updateViewDropdown() {
  const consoleOn   = isConsoleVisible();
  const bookmarksOn = isBookmarksBarVisible();
  document.getElementById('viewConsoleCheck').textContent   = consoleOn   ? '✓' : '';
  document.getElementById('viewBookmarksCheck').textContent = bookmarksOn ? '✓' : '';
  document.getElementById('viewToggleConsole').setAttribute('aria-checked', String(consoleOn));
  document.getElementById('viewToggleBookmarks').setAttribute('aria-checked', String(bookmarksOn));
}

function openViewDropdown() {
  const dd = document.getElementById('viewDropdown');
  if (dd.classList.contains('open')) return;
  closeAppMenu();
  dd.classList.add('open');
  document.getElementById('viewBtn').setAttribute('aria-expanded', 'true');
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
  document.getElementById('viewBtn').setAttribute('aria-expanded', 'false');
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
    if (!viewWrapper.contains(/** @type {Node} */ (e.target))) closeViewDropdown();
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

  // #295: the visible DevTools gear is gone; F12 and this entry remain.
  document.getElementById('viewMenuDevtools').addEventListener('click', () => {
    closeViewDropdown();
    const id = getActiveId();
    if (id) testerBrowser.sessions.devtools(id);
  });

  document.getElementById('viewMenuSettings').addEventListener('click', () => {
    closeViewDropdown();
    openSettings();
  });

  // The two toggles are role="menuitemcheckbox" divs (not real <button>s, to
  // keep the existing checkmark layout) — give them the keyboard activation
  // a real button/checkbox gets for free.
  [document.getElementById('viewToggleConsole'), document.getElementById('viewToggleBookmarks'),
    document.getElementById('viewMenuDevtools'), document.getElementById('viewMenuSettings')].forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.click();
      }
    });
  });
}
