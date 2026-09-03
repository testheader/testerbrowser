import { state } from './state.js';
import { loadStoragePanel } from './storage.js';
import { initA11y, enableA11yHover, disableA11yHover } from './a11y.js';
import { initDiff } from './diff.js';
import { initVR } from './visual-regression.js';
import { initSpoof } from './emulation.js';
import { initSecurity } from './security.js';
import { initMock } from './mock.js';
import { initResilience } from './resilience.js';
import { initJira } from './jira.js';
import { initRecordPlayback } from './record-playback.js';
import { renderTimeline } from './timeline.js';

export function switchConsoleTab(tab) {
  const prevTab = state.activeConsoleTab;
  state.activeConsoleTab = tab;
  if (prevTab === 'a11y' && tab !== 'a11y') disableA11yHover();
  document.getElementById('consoleTabConsole').classList.toggle('active', tab === 'console');
  document.getElementById('consoleTabNetwork').classList.toggle('active', tab === 'network');
  document.getElementById('consoleTabStorage').classList.toggle('active', tab === 'storage');
  document.getElementById('consoleTabA11y').classList.toggle('active', tab === 'a11y');
  document.getElementById('consoleTabDiff').classList.toggle('active', tab === 'diff');
  document.getElementById('consoleTabVR').classList.toggle('active', tab === 'vr');
  document.getElementById('consoleTabSpoof').classList.toggle('active', tab === 'spoof');
  document.getElementById('consoleTabSecurity').classList.toggle('active', tab === 'security');
  document.getElementById('consoleTabMock').classList.toggle('active', tab === 'mock');
  document.getElementById('consoleTabResilience').classList.toggle('active', tab === 'resilience');
  document.getElementById('consoleTabJira').classList.toggle('active', tab === 'jira');
  document.getElementById('consoleTabTests').classList.toggle('active', tab === 'tests');
  const timelineVisible = tab === 'console' || tab === 'network';
  document.getElementById('consoleControls').style.display      = tab === 'console'  ? ''      : 'none';
  document.getElementById('networkControls').style.display      = tab === 'network'  ? 'flex'  : 'none';
  document.getElementById('storageControls').style.display      = tab === 'storage'  ? 'flex'  : 'none';
  document.getElementById('timelinePanelWrapper').style.display = timelineVisible    ? 'flex'  : 'none';
  document.getElementById('storagePanel').style.display         = tab === 'storage'  ? 'block' : 'none';
  document.getElementById('a11yPanel').style.display            = tab === 'a11y'     ? 'flex'  : 'none';
  document.getElementById('diffPanel').style.display            = tab === 'diff'     ? 'flex'  : 'none';
  document.getElementById('vrPanel').style.display              = tab === 'vr'       ? 'flex'  : 'none';
  document.getElementById('spoofPanel').style.display           = tab === 'spoof'    ? 'flex'  : 'none';
  document.getElementById('securityPanel').style.display        = tab === 'security' ? 'flex'  : 'none';
  document.getElementById('mockPanel').style.display            = tab === 'mock'       ? 'flex'  : 'none';
  document.getElementById('resiliencePanel').style.display      = tab === 'resilience' ? 'flex'  : 'none';
  document.getElementById('jiraPanel').style.display            = tab === 'jira'       ? 'flex'  : 'none';
  document.getElementById('testsPanel').style.display           = tab === 'tests'      ? 'flex'  : 'none';
  const hasDetailTabs = state.detailTabs.length > 0;
  document.getElementById('detailPanel').classList.toggle('open', tab === 'console' && hasDetailTabs);
  document.getElementById('detailPanelResizeHandle').style.display = tab === 'console' && hasDetailTabs ? '' : 'none';
  if (tab === 'console' || tab === 'network') renderTimeline();
  if (tab === 'storage') loadStoragePanel();
  if (tab === 'a11y') { initA11y(); enableA11yHover(); }
  if (tab === 'spoof') initSpoof();
  if (tab === 'security') initSecurity();
  if (tab === 'mock') initMock();
  if (tab === 'resilience') initResilience();
  if (tab === 'jira') initJira();
  if (tab === 'tests') initRecordPlayback();
}

export function initConsoleTabs() {
  document.getElementById('consoleTabConsole').addEventListener('click', () => switchConsoleTab('console'));
  document.getElementById('consoleTabNetwork').addEventListener('click', () => switchConsoleTab('network'));
  document.getElementById('consoleTabStorage').addEventListener('click', () => switchConsoleTab('storage'));
  document.getElementById('consoleTabA11y').addEventListener('click', () => switchConsoleTab('a11y'));
  document.getElementById('consoleTabDiff').addEventListener('click', () => { switchConsoleTab('diff'); initDiff(); });
  document.getElementById('consoleTabVR').addEventListener('click', () => { switchConsoleTab('vr'); initVR(); });
  document.getElementById('consoleTabSpoof').addEventListener('click', () => switchConsoleTab('spoof'));
  document.getElementById('consoleTabSecurity').addEventListener('click', () => switchConsoleTab('security'));
  document.getElementById('consoleTabMock').addEventListener('click', () => switchConsoleTab('mock'));
  document.getElementById('consoleTabResilience').addEventListener('click', () => switchConsoleTab('resilience'));
  document.getElementById('consoleTabJira').addEventListener('click', () => { switchConsoleTab('jira'); initJira(); });
  document.getElementById('consoleTabTests').addEventListener('click', () => switchConsoleTab('tests'));
}
