/* global testerBrowser */
import { loadStoragePanel, stopStorageAutoRefreshPolling, resumeStorageAutoRefreshIfOn } from './storage.js';
import { initA11y, disableA11yHover, disableA11yFocusOrder } from './a11y.js';
import { initDiff } from './diff.js';
import { initVR, refreshVR } from './visual-regression.js';
import { initSpoof, refreshSpoofStatus } from './emulation.js';
import { initSecurity } from './security.js';
import { initMock } from './mock.js';
import { initResilience } from './resilience.js';
import { initJira } from './jira.js';
import { initRecordPlayback } from './record-playback.js';
import { initFollow, refreshFollowPickers } from './followalong.js';
import { renderTimeline } from './timeline.js';
import { renderDetailPanel } from './detail-panel.js';
import { initDebugLog } from './debuglog.js';
import { isConsolePanelMinimized, expandConsolePanel } from './layout.js';

// Console-tab name -> its button id. Shared by switchConsoleTab() and
// applyConsoleTabVisibility() (#285 — Settings → Features tab toggles).
const CONSOLE_TAB_BUTTONS = {
  console: 'consoleTabConsole', network: 'consoleTabNetwork', storage: 'consoleTabStorage',
  a11y: 'consoleTabA11y', diff: 'consoleTabDiff', vr: 'consoleTabVR', spoof: 'consoleTabSpoof',
  security: 'consoleTabSecurity', mock: 'consoleTabMock', resilience: 'consoleTabResilience',
  jira: 'consoleTabJira', tests: 'consoleTabTests', follow: 'consoleTabFollow', debuglog: 'consoleTabDebugLog',
};

// The only external readers of activeConsoleTab (many — find, timeline,
// detail-panel, bugreport, mock, resilience, ipc-events, main) go through
// getActiveConsoleTab(); nothing outside this file writes it.
let activeConsoleTab = 'console';

export function getActiveConsoleTab() { return activeConsoleTab; }

// #285: hides/shows console-tab buttons per the user's Settings → Features
// toggles. If the currently active tab just got hidden, falls back to the
// Console tab (which, like Network, is never in disabledConsoleTabs).
export function applyConsoleTabVisibility(disabledTabs) {
  const disabled = new Set(disabledTabs || []);
  for (const [tabName, id] of Object.entries(CONSOLE_TAB_BUTTONS)) {
    document.getElementById(id).hidden = disabled.has(tabName);
  }
  if (disabled.has(activeConsoleTab)) switchConsoleTab('console');
  updateTabOverflow();
}

export function switchConsoleTab(tab) {
  const prevTab = activeConsoleTab;
  activeConsoleTab = tab;
  if (prevTab === 'a11y' && tab !== 'a11y') { disableA11yHover(); disableA11yFocusOrder(); }
  if (prevTab === 'storage' && tab !== 'storage') stopStorageAutoRefreshPolling();
  for (const [tabName, id] of Object.entries(CONSOLE_TAB_BUTTONS)) {
    const el = document.getElementById(id);
    const selected = tab === tabName;
    el.classList.toggle('active', selected);
    el.setAttribute('aria-selected', String(selected));
  }
  const timelineVisible = tab === 'console' || tab === 'network';
  document.getElementById('consoleControls').style.display      = tab === 'console'  ? ''      : 'none';
  document.getElementById('networkControls').style.display      = tab === 'network'  ? 'flex'  : 'none';
  document.getElementById('storageControls').style.display      = tab === 'storage'  ? 'flex'  : 'none';
  document.getElementById('timelinePanelWrapper').style.display = timelineVisible    ? 'flex'  : 'none';
  document.getElementById('storagePanel').style.display         = tab === 'storage'  ? 'flex'  : 'none';
  document.getElementById('a11yPanel').style.display            = tab === 'a11y'     ? 'flex'  : 'none';
  document.getElementById('diffPanel').style.display            = tab === 'diff'     ? 'flex'  : 'none';
  document.getElementById('vrPanel').style.display              = tab === 'vr'       ? 'flex'  : 'none';
  document.getElementById('spoofPanel').style.display           = tab === 'spoof'    ? 'flex'  : 'none';
  document.getElementById('securityPanel').style.display        = tab === 'security' ? 'flex'  : 'none';
  document.getElementById('mockPanel').style.display            = tab === 'mock'       ? 'flex'  : 'none';
  document.getElementById('resiliencePanel').style.display      = tab === 'resilience' ? 'flex'  : 'none';
  document.getElementById('jiraPanel').style.display            = tab === 'jira'       ? 'flex'  : 'none';
  document.getElementById('testsPanel').style.display           = tab === 'tests'      ? 'flex'  : 'none';
  document.getElementById('followPanel').style.display          = tab === 'follow'     ? 'flex'  : 'none';
  document.getElementById('debugLogPanel').style.display        = tab === 'debuglog'   ? 'flex'  : 'none';
  // #324: re-render so the pane shows the item belonging to this tool (or closes).
  renderDetailPanel();
  if (tab === 'console' || tab === 'network') renderTimeline();
  if (tab === 'storage') { loadStoragePanel(); resumeStorageAutoRefreshIfOn(); }
  if (tab === 'a11y') { initA11y(); }
  if (tab === 'spoof') { initSpoof(); refreshSpoofStatus(); }
  if (tab === 'security') initSecurity();
  if (tab === 'mock') initMock();
  if (tab === 'resilience') initResilience();
  if (tab === 'jira') initJira();
  if (tab === 'tests') initRecordPlayback();
  if (tab === 'follow') { initFollow(); refreshFollowPickers(); }
  if (tab === 'debuglog') initDebugLog();
  updateTabOverflow();
}

export function initConsoleTabs() {
  document.getElementById('consoleTabConsole').addEventListener('click', () => switchConsoleTab('console'));
  document.getElementById('consoleTabNetwork').addEventListener('click', () => switchConsoleTab('network'));
  document.getElementById('consoleTabStorage').addEventListener('click', () => switchConsoleTab('storage'));
  document.getElementById('consoleTabA11y').addEventListener('click', () => switchConsoleTab('a11y'));
  document.getElementById('consoleTabDiff').addEventListener('click', () => { switchConsoleTab('diff'); initDiff(); });
  document.getElementById('consoleTabVR').addEventListener('click', () => { switchConsoleTab('vr'); initVR(); refreshVR(); });
  document.getElementById('consoleTabSpoof').addEventListener('click', () => switchConsoleTab('spoof'));
  document.getElementById('consoleTabSecurity').addEventListener('click', () => switchConsoleTab('security'));
  document.getElementById('consoleTabMock').addEventListener('click', () => switchConsoleTab('mock'));
  document.getElementById('consoleTabResilience').addEventListener('click', () => switchConsoleTab('resilience'));
  document.getElementById('consoleTabJira').addEventListener('click', () => { switchConsoleTab('jira'); initJira(); });
  document.getElementById('consoleTabTests').addEventListener('click', () => switchConsoleTab('tests'));
  document.getElementById('consoleTabFollow').addEventListener('click', () => switchConsoleTab('follow'));
  document.getElementById('consoleTabDebugLog').addEventListener('click', () => switchConsoleTab('debuglog'));

  initTabOverflow();
  // #297: clicking any tab while the panel is collapsed expands it first.
  for (const tab of document.querySelectorAll('#consoleTabsStrip .console-tab')) {
    tab.addEventListener('click', () => { if (isConsolePanelMinimized()) expandConsolePanel(); });
  }
  testerBrowser.settings.get().then((s) => applyConsoleTabVisibility(s.disabledConsoleTabs));
}

// #332: tabs that don't fit the strip are listed in a "More (N)" menu (each with
// its badge, if any) instead of being reached with scroll arrows.
let updateTabOverflow = () => {};

function hiddenOverflowTabs() {
  const strip = document.getElementById('consoleTabsStrip');
  const right = strip.getBoundingClientRect().right;
  return [...strip.querySelectorAll('.console-tab:not([hidden])')]
    .filter((btn) => btn.getBoundingClientRect().right > right + 1);
}

function initTabOverflow() {
  const strip = document.getElementById('consoleTabsStrip');
  const moreBtn = document.getElementById('consoleTabsMoreBtn');
  const menu = document.getElementById('consoleTabsMoreMenu');

  function closeMenu() {
    menu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
  }

  function buildMenu(tabs) {
    menu.replaceChildren(...tabs.map((tab) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'console-more-item' + (tab.classList.contains('active') ? ' active' : '');
      item.setAttribute('role', 'menuitem');
      item.dataset.tabId = tab.id;
      const icon = tab.querySelector('i');
      if (icon) item.appendChild(icon.cloneNode(true));
      const label = document.createElement('span');
      label.textContent = tab.querySelector('span')?.textContent || '';
      item.appendChild(label);
      const badge = tab.querySelector('.tab-badge');
      if (badge) item.appendChild(badge.cloneNode(true));
      item.addEventListener('click', () => { closeMenu(); tab.click(); });
      return item;
    }));
  }

  updateTabOverflow = () => {
    const tabs = hiddenOverflowTabs();
    moreBtn.hidden = tabs.length === 0;
    if (tabs.length === 0) { closeMenu(); return; }
    document.getElementById('consoleTabsMoreLabel').textContent = `More (${tabs.length})`;
    moreBtn.classList.toggle('active', tabs.some((t) => t.classList.contains('active')));
    if (!menu.hidden) buildMenu(tabs);
  };

  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menu.hidden) { closeMenu(); return; }
    if (isConsolePanelMinimized()) expandConsolePanel();
    buildMenu(hiddenOverflowTabs());
    menu.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(/** @type {Node} */ (e.target))) closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', () => updateTabOverflow());
  // Tabs grow when a badge appears or the active tab turns bold, which changes what fits.
  const ro = new ResizeObserver(() => updateTabOverflow());
  ro.observe(strip);
  strip.querySelectorAll('.console-tab').forEach((t) => ro.observe(t));

  updateTabOverflow();
}
