/* global testerBrowser */
// #367: with several windows open, a theme, settings or bookmarks change made in one
// window is announced by main to the others; each re-reads what it shows.
import { loadBookmarks } from './bookmarks.js';
import { applyTheme, getStoredScheme } from './theme.js';
import { applyConsoleTabVisibility } from './console-tabs.js';

export function initAppBroadcast() {
  testerBrowser.app.onBroadcast((kind) => {
    if (kind === 'bookmarks') {
      loadBookmarks();
    } else if (kind === 'theme') {
      // The chosen scheme lives in localStorage, shared by every window of this app.
      applyTheme(getStoredScheme(), { notify: false });
    } else if (kind === 'settings') {
      testerBrowser.settings.get().then((s) => applyConsoleTabVisibility(s.disabledConsoleTabs));
    }
  });
}
