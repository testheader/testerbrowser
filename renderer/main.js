/* global testerBrowser */
import { initLayout, updateTopBarHeight, initMinimize, getConsoleHeight } from './layout.js';
import { initToolbar, loadUrlHistory } from './toolbar.js';
import { initBookmarks, loadBookmarks } from './bookmarks.js';
import { initFind } from './find.js';
import { initTabs, refreshTabs } from './tabs.js';
import { initDownloads } from './downloads.js';
import { initPermissions } from './permissions.js';
import { initStorage } from './storage.js';
import { initDetailPanel } from './detail-panel.js';
import { initTimeline, pollTimeline } from './timeline.js';
import { initReplay } from './replay.js';
import { initNotes } from './notes.js';
import { initHistory } from './history.js';
import { initSettings } from './settings.js';
import { initBugReport } from './bugreport.js';
import { initConsoleTabs, switchConsoleTab, getActiveConsoleTab } from './console-tabs.js';
import { initA11y } from './a11y.js';
import './diff.js';
import './visual-regression.js';
import { initTestdata } from './testdata.js';
import './emulation.js';
import './security.js';
import './mock.js';
import './resilience.js';
import './jira.js';
import { initRecordPlayback } from './record-playback.js';
import './followalong.js';
import { initViewDropdown } from './view-dropdown.js';
import { initAppMenu } from './app-menu.js';
import { initShortcuts } from './shortcuts.js';
import { initIpcEvents } from './ipc-events.js';
import { initTheme } from './theme.js';

// Feeds the bug report's diagnostics preview — main-process errors were
// already recorded, but nothing captured errors from this chrome UI's own
// renderer, so the log was almost always empty for the actual UI bugs a
// tester would report. Registered before any other init so an error thrown
// during startup itself still gets reported.
window.addEventListener('error', (e) =>
  testerBrowser.app.reportError(`Renderer error: ${e.message} (${e.filename}:${e.lineno}:${e.colno})\n${e.error?.stack || ''}`));
window.addEventListener('unhandledrejection', (e) =>
  testerBrowser.app.reportError(`Renderer unhandled rejection: ${e.reason?.stack || e.reason}`));

initTheme();
initLayout();
initMinimize();
initToolbar();
initBookmarks();
initFind();
initTabs();
initDownloads();
initPermissions();
initStorage();
initDetailPanel();
initTimeline();
initReplay();
initRecordPlayback();
initNotes();
initHistory();
initSettings();
initBugReport();
initConsoleTabs();
// Drive the initial tab state through the same path as a click, so control
// visibility never depends on static markup defaults.
switchConsoleTab(getActiveConsoleTab());
initA11y();
initTestdata();
initViewDropdown();
initAppMenu();
initShortcuts();
initIpcEvents();

// Boot
updateTopBarHeight();
testerBrowser.layout.setConsoleHeight(getConsoleHeight());
refreshTabs();
loadBookmarks();
loadUrlHistory();
pollTimeline();
