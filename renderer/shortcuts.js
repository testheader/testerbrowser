/* global testerBrowser */
import { closeTab, reopenTab, switchToSession, cycleTab, getActiveId, getTabOrder, isTabLoading } from './tabs.js';
import { openFind, closeFind, doFind } from './find.js';
import { toggleBookmark, toggleBookmarksBar } from './bookmarks.js';
import { isFindOpen } from './layout.js';

function handleShortcut(key) {
  const activeId = getActiveId();
  switch (key) {
    case 'newTab':             document.getElementById('newSessionBtn').onclick(); break;
    case 'closeTab':           if (activeId) closeTab(activeId); break;
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

export function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Tab')              { e.preventDefault(); cycleTab(e.shiftKey); return; }
    if (e.ctrlKey && !e.shiftKey && e.key === 't') { e.preventDefault(); handleShortcut('newTab');    return; }
    if (e.ctrlKey && !e.shiftKey && e.key === 'w') { e.preventDefault(); handleShortcut('closeTab');  return; }
    if (e.ctrlKey && e.shiftKey  && e.key === 'T') { e.preventDefault(); handleShortcut('reopenTab'); return; }
    if (e.ctrlKey && e.key === 'l')                { e.preventDefault(); handleShortcut('focusUrl');          return; }
    if (e.ctrlKey && e.key === 'f')                { e.preventDefault(); handleShortcut('findToggle');        return; }
    if (e.ctrlKey && !e.shiftKey && e.key === 'd') { e.preventDefault(); handleShortcut('bookmark');    return; }
    if (e.ctrlKey && e.shiftKey && e.key === 'B')  { e.preventDefault(); handleShortcut('toggleBookmarksBar'); return; }
    if (e.key === 'F3')                            { e.preventDefault(); handleShortcut(e.shiftKey ? 'findPrev' : 'findNext'); return; }
    if ((e.ctrlKey && e.key === 'r') || e.key === 'F5') { e.preventDefault(); handleShortcut('reload'); return; }
    if (e.key === 'Escape')                        { e.preventDefault(); handleShortcut('stopOrEsc'); return; }
    if (e.key === 'F12')                           { e.preventDefault(); if (getActiveId()) testerBrowser.sessions.devtools(getActiveId()); return; }
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); if (getActiveId()) testerBrowser.sessions.setZoom(getActiveId(),  0.1); return; }
    if (e.ctrlKey && e.key === '-')                { e.preventDefault(); if (getActiveId()) testerBrowser.sessions.setZoom(getActiveId(), -0.1); return; }
    if (e.ctrlKey && e.key === '0')                { e.preventDefault(); if (getActiveId()) testerBrowser.sessions.resetZoom(getActiveId());    return; }
    if (e.altKey  && e.key === 'ArrowLeft')        { e.preventDefault(); if (getActiveId()) testerBrowser.sessions.back(getActiveId());         return; }
    if (e.altKey  && e.key === 'ArrowRight')       { e.preventDefault(); if (getActiveId()) testerBrowser.sessions.forward(getActiveId());      return; }
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') { e.preventDefault(); handleShortcut(`switchTab:${e.key}`); return; }
  });

  testerBrowser.sessions.onShortcut((key) => handleShortcut(key));
}
