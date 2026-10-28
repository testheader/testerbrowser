/* global testerBrowser */
import { openSettings } from './settings.js';
import { openBugReport } from './bugreport.js';
import { newSession, getActiveId } from './tabs.js';
import { isConsoleVisible, toggleConsoleVisible, isBookmarksBarVisible, beginPageOverlay, endPageOverlay } from './layout.js';
import { toggleBookmarksBar } from './bookmarks.js';
import { openTestdataModal } from './testdata.js';

const $ = (id) => document.getElementById(id);

function updateToggles() {
  const consoleOn   = isConsoleVisible();
  const bookmarksOn = isBookmarksBarVisible();
  $('appMenuConsoleCheck').textContent   = consoleOn   ? '✓' : '';
  $('appMenuBookmarksCheck').textContent = bookmarksOn ? '✓' : '';
  $('appMenuToggleConsole').setAttribute('aria-checked', String(consoleOn));
  $('appMenuToggleBookmarks').setAttribute('aria-checked', String(bookmarksOn));
}

// The dropdown can extend past the topbar into the region the native view
// occupies — that view always paints over page HTML regardless of z-index,
// so the page is snapshotted and the view detached while the menu is open
// instead of just pushing the view down,
// which used to shove the whole page out of place. A side effect that
// happens to fix #177's "click in the page doesn't close the menu" bug for
// free: while the menu is open there is no live native view over the page
// area to swallow the click — #pageSnapshot sits there instead, plain chrome
// HTML, so a click on it reaches this module's own outside-click listener
// below like any other chrome click. (The click only dismisses the menu; it
// is not forwarded to the real page underneath, which is fully detached and
// has nothing to receive it — matching how a menu-dismiss click behaves in
// most desktop apps.)
function openAppMenu() {
  const dropdown = document.getElementById('appMenuDropdown');
  if (dropdown.classList.contains('open')) return;
  dropdown.classList.add('open');
  $('appName').setAttribute('aria-expanded', 'true');
  updateToggles();
  beginPageOverlay();
}

export function closeAppMenu() {
  const dropdown = document.getElementById('appMenuDropdown');
  if (!dropdown.classList.contains('open')) return;
  dropdown.classList.remove('open');
  $('appName').setAttribute('aria-expanded', 'false');
  endPageOverlay();
}

export function initAppMenu() {
  const wrapper  = document.getElementById('appMenuWrapper');
  const dropdown = document.getElementById('appMenuDropdown');

  document.getElementById('appName').addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.contains('open') ? closeAppMenu() : openAppMenu();
  });

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(/** @type {Node} */ (e.target))) closeAppMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAppMenu();
  });

  document.getElementById('appMenuNewTemp').addEventListener('click', () => {
    closeAppMenu();
    newSession({ persistent: false });
  });

  document.getElementById('appMenuTestData').addEventListener('click', () => {
    closeAppMenu();
    const id = getActiveId();
    if (id) openTestdataModal(id);
  });

  document.getElementById('appMenuSettings').addEventListener('click', () => {
    closeAppMenu();
    openSettings();
  });

  document.getElementById('appMenuBugReport').addEventListener('click', () => {
    closeAppMenu();
    openBugReport();
  });

  $('appMenuToggleConsole').addEventListener('click', () => {
    toggleConsoleVisible();
    closeAppMenu();
  });

  $('appMenuToggleBookmarks').addEventListener('click', () => {
    toggleBookmarksBar();
    closeAppMenu();
  });

  // #295: the visible DevTools gear is gone; F12 and this entry remain.
  $('appMenuDevtools').addEventListener('click', () => {
    closeAppMenu();
    const id = getActiveId();
    if (id) testerBrowser.sessions.devtools(id);
  });

  // Items are divs (to keep the checkmark layout), not real <button>s — give
  // them the keyboard activation a button gets for free.
  dropdown.querySelectorAll('.view-item').forEach((el) => {
    el.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        /** @type {HTMLElement} */ (el).click();
      }
    });
  });
}
