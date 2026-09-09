import { openSettings } from './settings.js';
import { openBugReport } from './bugreport.js';
import { newSession } from './tabs.js';
import { beginPageOverlay, endPageOverlay } from './layout.js';
import { closeViewDropdown } from './view-dropdown.js';

// The dropdown can extend past the topbar into the region the native view
// occupies — that view always paints over page HTML regardless of z-index,
// so the page is snapshotted and the view detached while the menu is open
// (same pattern as view-dropdown.js) instead of just pushing the view down,
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
  closeViewDropdown();
  dropdown.classList.add('open');
  beginPageOverlay();
}

export function closeAppMenu() {
  const dropdown = document.getElementById('appMenuDropdown');
  if (!dropdown.classList.contains('open')) return;
  dropdown.classList.remove('open');
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
    if (!wrapper.contains(e.target)) closeAppMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAppMenu();
  });

  document.getElementById('appMenuNewTemp').addEventListener('click', () => {
    closeAppMenu();
    newSession({ persistent: false });
  });

  document.getElementById('appMenuSettings').addEventListener('click', () => {
    closeAppMenu();
    openSettings();
  });

  document.getElementById('appMenuBugReport').addEventListener('click', () => {
    closeAppMenu();
    openBugReport();
  });
}
