/* global testerBrowser */
import { closeTab, reopenTab, switchToSession, cycleTab, getActiveId, getTabOrder, isTabLoading, isPinned } from './tabs.js';
import { openFind, closeFind, doFind } from './find.js';
import { toggleBookmark, toggleBookmarksBar } from './bookmarks.js';
import { isFindOpen } from './layout.js';
import { matchShortcut } from './shortcut-table.js';

function handleShortcut(key) {
  const activeId = getActiveId();
  switch (key) {
    case 'newTab':             document.getElementById('newSessionBtn').onclick(); break;
    // Guarded here, at the shortcut call site, rather than inside closeTab()
    // itself — the tab context menu's own Close item calls closeTab()
    // directly and is an explicit user choice that should still work on a
    // pinned tab (see #223's "out of scope").
    case 'closeTab':           if (activeId && !isPinned(activeId)) closeTab(activeId); break;
    case 'reopenTab':          reopenTab(); break;
    case 'focusUrl':           { const u = document.getElementById('urlbar'); u.focus(); u.select(); } break;
    case 'reload':             if (activeId) testerBrowser.sessions.reload(activeId); break;
    case 'findToggle':         isFindOpen() ? closeFind() : openFind(); break;
    case 'findNext':           doFind(true,  true); break;
    case 'findPrev':           doFind(false, true); break;
    case 'bookmark':           toggleBookmark(); break;
    case 'toggleBookmarksBar': toggleBookmarksBar(); break;
    case 'stopOrEsc':
      if (activeId && isTabLoading(activeId)) testerBrowser.sessions.stop(activeId);
      else if (isFindOpen()) closeFind();
      break;
    default:
      if (key.startsWith('switchTab:')) {
        const n = parseInt(key.slice(10)) - 1;
        const tabOrder = getTabOrder();
        // Ctrl+9 always goes to last tab (Chrome behaviour)
        const targetId = n === 8 ? tabOrder[tabOrder.length - 1] : tabOrder[n];
        if (targetId) switchToSession(targetId);
      }
  }
}

// The `direct` shortcuts (devtools/zoom/back-forward) are handled here too,
// not just by main's before-input-event — this listener covers the
// chrome-focused case (urlbar, console panel, no tab view underneath),
// where there's nothing to forward to and testerBrowser is called directly.
function dispatchDirect(action) {
  const id = getActiveId();
  if (!id) return;
  switch (action) {
    case 'devtools':  testerBrowser.sessions.devtools(id); break;
    case 'zoomIn':    testerBrowser.sessions.setZoom(id, 0.1); break;
    case 'zoomOut':   testerBrowser.sessions.setZoom(id, -0.1); break;
    case 'zoomReset': testerBrowser.sessions.resetZoom(id); break;
    case 'back':      testerBrowser.sessions.back(id); break;
    case 'forward':   testerBrowser.sessions.forward(id); break;
  }
}

export function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+Tab and Ctrl+1–9 carry extra data a flat key match can't express
    // — see shortcut-table.js for why these stay their own branches ahead
    // of the shared table instead of being entries in it.
    if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey); return; }
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') { e.preventDefault(); handleShortcut(`switchTab:${e.key}`); return; }

    const match = matchShortcut({ ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, key: e.key });
    if (!match) return;
    e.preventDefault();
    if (match.direct) dispatchDirect(match.action);
    else handleShortcut(match.action);
  });

  testerBrowser.sessions.onShortcut((key) => handleShortcut(key));
}
