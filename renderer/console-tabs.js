import { state } from './state.js';
import { loadStoragePanel } from './storage.js';
import { loadA11yPanel } from './a11y.js';
import { initDiff } from './diff.js';
import { initVR } from './visual-regression.js';
import { initSpoof } from './emulation.js';
import { initSecurity } from './security.js';
import { initMock } from './mock.js';

export function switchConsoleTab(tab) {
  state.activeConsoleTab = tab;
  document.getElementById('consoleTabConsole').classList.toggle('active', tab === 'console');
  document.getElementById('consoleTabStorage').classList.toggle('active', tab === 'storage');
  document.getElementById('consoleTabA11y').classList.toggle('active', tab === 'a11y');
  document.getElementById('consoleTabDiff').classList.toggle('active', tab === 'diff');
  document.getElementById('consoleTabVR').classList.toggle('active', tab === 'vr');
  document.getElementById('consoleTabSpoof').classList.toggle('active', tab === 'spoof');
  document.getElementById('consoleTabSecurity').classList.toggle('active', tab === 'security');
  document.getElementById('consoleControls').style.display      = tab === 'console'  ? ''      : 'none';
  document.getElementById('storageControls').style.display      = tab === 'storage'  ? 'flex'  : 'none';
  document.getElementById('timelinePanelWrapper').style.display = tab === 'console'  ? 'flex'  : 'none';
  document.getElementById('storagePanel').style.display         = tab === 'storage'  ? 'block' : 'none';
  document.getElementById('a11yPanel').style.display            = tab === 'a11y'     ? 'block' : 'none';
  document.getElementById('diffPanel').style.display            = tab === 'diff'     ? 'flex'  : 'none';
  document.getElementById('vrPanel').style.display              = tab === 'vr'       ? 'flex'  : 'none';
  document.getElementById('spoofPanel').style.display           = tab === 'spoof'    ? 'flex'  : 'none';
  document.getElementById('securityPanel').style.display        = tab === 'security' ? 'flex'  : 'none';
  document.getElementById('mockPanel').style.display            = tab === 'mock'     ? 'flex'  : 'none';
  const hasDetailTabs = state.detailTabs.length > 0;
  document.getElementById('detailPanel').classList.toggle('open', tab === 'console' && hasDetailTabs);
  document.getElementById('detailPanelResizeHandle').style.display = tab === 'console' && hasDetailTabs ? '' : 'none';
  if (tab === 'storage') loadStoragePanel();
  if (tab === 'a11y') loadA11yPanel();
  if (tab === 'spoof') initSpoof();
  if (tab === 'security') initSecurity();
  if (tab === 'mock') initMock();
}

export function initConsoleTabs() {
  document.getElementById('consoleTabConsole').addEventListener('click', () => switchConsoleTab('console'));
  document.getElementById('consoleTabStorage').addEventListener('click', () => switchConsoleTab('storage'));
  document.getElementById('consoleTabA11y').addEventListener('click', () => switchConsoleTab('a11y'));
  document.getElementById('consoleTabDiff').addEventListener('click', () => { switchConsoleTab('diff'); initDiff(); });
  document.getElementById('consoleTabVR').addEventListener('click', () => { switchConsoleTab('vr'); initVR(); });
  document.getElementById('consoleTabSpoof').addEventListener('click', () => switchConsoleTab('spoof'));
  document.getElementById('consoleTabSecurity').addEventListener('click', () => switchConsoleTab('security'));
  document.getElementById('consoleTabMock').addEventListener('click', () => switchConsoleTab('mock'));
}
