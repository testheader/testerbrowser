/* global testerBrowser */
import { openSettings } from './settings.js';
import { openBugReport } from './bugreport.js';
import { newSession } from './tabs.js';
import { currentTopBarHeight } from './layout.js';

// The dropdown can extend past the topbar into the region the BrowserView
// occupies — that native view always paints over page HTML regardless of
// z-index, so the view's top edge is pushed down to clear the dropdown
// (same pattern as view-dropdown.js) instead of detaching it entirely,
// which would blank out the whole page while the menu is open.
function openAppMenu() {
  const dropdown = document.getElementById('appMenuDropdown');
  if (dropdown.classList.contains('open')) return;
  dropdown.classList.add('open');
  const inset = Math.max(0, dropdown.getBoundingClientRect().bottom - currentTopBarHeight());
  testerBrowser.layout.setTopInset(inset);
}

function closeAppMenu() {
  const dropdown = document.getElementById('appMenuDropdown');
  if (!dropdown.classList.contains('open')) return;
  dropdown.classList.remove('open');
  testerBrowser.layout.setTopInset(0);
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
