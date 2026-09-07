/* global testerBrowser */
import { setLoadingBar, updateReloadBtn } from './toolbar.js';
import { updateBookmarkStar } from './bookmarks.js';
import { updateTabLoadingVisual, startRename, closeTab, refreshTabs, getActiveId, setTabLoading } from './tabs.js';
import { loadStoragePanel } from './storage.js';
import { reloadA11yIfLoaded } from './a11y.js';
import { clearSecurityFindings } from './security.js';
import { openNotes } from './notes.js';
import { updateUrlbarSecurity } from './urlbar-security.js';
import { getActiveConsoleTab } from './console-tabs.js';

export function initIpcEvents() {
  // onLoading is cross-cutting: updates tab icon AND toolbar reload button / loading bar
  testerBrowser.sessions.onLoading(({ id, loading }) => {
    setTabLoading(id, loading);
    const tab = document.querySelector(`.tab[data-id="${id}"]`);
    if (tab) updateTabLoadingVisual(tab, id);
    if (id === getActiveId()) {
      updateReloadBtn();
      setLoadingBar(loading);
    }
  });

  // onNavigated touches toolbar (URL bar), bookmarks (star), and storage panel
  testerBrowser.sessions.onNavigated(({ id, url }) => {
    if (id === getActiveId()) {
      document.getElementById('urlbar').value = url;
      updateUrlbarSecurity(url);
      updateBookmarkStar();
      const activeConsoleTab = getActiveConsoleTab();
      if (activeConsoleTab === 'storage') loadStoragePanel();
      if (activeConsoleTab === 'a11y') reloadA11yIfLoaded();
      if (activeConsoleTab === 'security') clearSecurityFindings();
    }
  });

  // onTabAction dispatches to tabs and notes
  testerBrowser.sessions.onTabAction(({ action, id }) => {
    if (action === 'rename') {
      const el = document.querySelector(`.tab[data-id="${id}"] .tab-name`);
      if (el) startRename(id, el);
    }
    if (action === 'close')   closeTab(id);
    if (action === 'notes')   openNotes(id);
    if (action === 'refresh') refreshTabs();
  });
}
