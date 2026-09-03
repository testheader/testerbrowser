/* global testerBrowser */
import { state } from './state.js';
import { setLoadingBar, updateReloadBtn } from './toolbar.js';
import { updateBookmarkStar } from './bookmarks.js';
import { updateTabLoadingVisual, startRename, closeTab, refreshTabs } from './tabs.js';
import { loadStoragePanel } from './storage.js';
import { reloadA11yIfLoaded } from './a11y.js';
import { openNotes } from './notes.js';

export function initIpcEvents() {
  // onLoading is cross-cutting: updates tab icon AND toolbar reload button / loading bar
  testerBrowser.sessions.onLoading(({ id, loading }) => {
    state.tabLoading[id] = loading;
    const tab = document.querySelector(`.tab[data-id="${id}"]`);
    if (tab) updateTabLoadingVisual(tab, id);
    if (id === state.activeId) {
      updateReloadBtn();
      setLoadingBar(loading);
    }
  });

  // onNavigated touches toolbar (URL bar), bookmarks (star), and storage panel
  testerBrowser.sessions.onNavigated(({ id, url }) => {
    if (id === state.activeId) {
      document.getElementById('urlbar').value = url;
      updateBookmarkStar();
      if (state.activeConsoleTab === 'storage') loadStoragePanel();
      if (state.activeConsoleTab === 'a11y') reloadA11yIfLoaded();
    }
  });

  // onTabAction dispatches to tabs and notes
  testerBrowser.sessions.onTabAction(({ action, id }) => {
    if (action === 'rename') {
      const el = document.querySelector(`.tab[data-id="${id}"] .tab-name`);
      if (el) { clearTimeout(state.tabClickTimer); startRename(id, el); }
    }
    if (action === 'close')   closeTab(id);
    if (action === 'notes')   openNotes(id);
    if (action === 'refresh') refreshTabs();
  });
}
