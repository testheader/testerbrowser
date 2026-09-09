import { openSettings } from './settings.js';
import { openBugReport } from './bugreport.js';
import { newSession } from './tabs.js';
import { beginPageOverlay, endPageOverlay } from './layout.js';

// The dropdown can extend past the topbar into the region the native view
// occupies — that view always paints over page HTML regardless of z-index,
// so the page is snapshotted and the view detached while the menu is open
// (same pattern as view-dropdown.js) instead of just pushing the view down,
// which used to shove the whole page out of place.
function openAppMenu() {
  const dropdown = document.getElementById('appMenuDropdown');
  if (dropdown.classList.contains('open')) return;
  dropdown.classList.add('open');
  beginPageOverlay();
}

function closeAppMenu() {
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
