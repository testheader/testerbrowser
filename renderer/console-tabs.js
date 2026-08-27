import { state } from './state.js';
import { loadStoragePanel } from './storage.js';

export function switchConsoleTab(tab) {
  state.activeConsoleTab = tab;
  document.getElementById('consoleTabConsole').classList.toggle('active', tab === 'console');
  document.getElementById('consoleTabStorage').classList.toggle('active', tab === 'storage');
  document.getElementById('consoleControls').style.display      = tab === 'console' ? ''      : 'none';
  document.getElementById('storageControls').style.display      = tab === 'storage' ? 'flex'  : 'none';
  document.getElementById('timelinePanelWrapper').style.display = tab === 'console' ? 'flex'  : 'none';
  document.getElementById('storagePanel').style.display         = tab === 'storage' ? 'block' : 'none';
  const hasDetailTabs = state.detailTabs.length > 0;
  document.getElementById('detailPanel').classList.toggle('open', tab === 'console' && hasDetailTabs);
  document.getElementById('detailPanelResizeHandle').style.display = tab === 'console' && hasDetailTabs ? '' : 'none';
  if (tab === 'storage') loadStoragePanel();
}

export function initConsoleTabs() {
  document.getElementById('consoleTabConsole').addEventListener('click', () => switchConsoleTab('console'));
  document.getElementById('consoleTabStorage').addEventListener('click', () => switchConsoleTab('storage'));
}
