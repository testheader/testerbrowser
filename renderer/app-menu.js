import { openSettings } from './settings.js';
import { openBugReport } from './bugreport.js';
import { newSession } from './tabs.js';

function closeAppMenu() {
  document.getElementById('appMenuDropdown').classList.remove('open');
}

export function initAppMenu() {
  const wrapper  = document.getElementById('appMenuWrapper');
  const dropdown = document.getElementById('appMenuDropdown');

  document.getElementById('appName').addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
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
