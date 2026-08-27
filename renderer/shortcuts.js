/* global testerBrowser */
import { state } from './state.js';
import { closeTab, reopenTab, switchToSession, cycleTab } from './tabs.js';
import { openFind, closeFind, doFind } from './find.js';
import { toggleBookmark, toggleBookmarksBar } from './bookmarks.js';

function handleShortcut(key) {
  switch (key) {
    case 'newTab':             document.getElementById('newSessionBtn').onclick(); break;
    case 'closeTab':           if (state.activeId) closeTab(state.activeId); break;
    case 'reopenTab':          reopenTab(); break;
    case 'focusUrl':           { const u = document.getElementById('urlbar'); u.focus(); u.select(); } break;
    case 'reload':             if (state.activeId) testerBrowser.sessions.reload(state.activeId); break;
    case 'findToggle':         state.findOpen ? closeFind() : openFind(); break;
    case 'findNext':           doFind(true,  true); break;
    case 'findPrev':           doFind(false, true); break;
    case 'bookmark':           toggleBookmark(); break;
    case 'toggleBookmarksBar': toggleBookmarksBar(); break;
    case 'stopOrEsc':
      if (state.activeId && state.tabLoading[state.activeId]) testerBrowser.sessions.stop(state.activeId);
      else if (state.findOpen) closeFind();
      break;
    default:
      if (key.startsWith('switchTab:')) {
        const n = parseInt(key.slice(10)) - 1;
        // Ctrl+9 always goes to last tab (Chrome behaviour)
        const targetId = n === 8 ? state.tabOrder[state.tabOrder.length - 1] : state.tabOrder[n];
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
    if (e.key === 'F12')                           { e.preventDefault(); if (state.activeId) testerBrowser.sessions.devtools(state.activeId); return; }
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); if (state.activeId) testerBrowser.sessions.setZoom(state.activeId,  0.1); return; }
    if (e.ctrlKey && e.key === '-')                { e.preventDefault(); if (state.activeId) testerBrowser.sessions.setZoom(state.activeId, -0.1); return; }
    if (e.ctrlKey && e.key === '0')                { e.preventDefault(); if (state.activeId) testerBrowser.sessions.resetZoom(state.activeId);    return; }
    if (e.altKey  && e.key === 'ArrowLeft')        { e.preventDefault(); if (state.activeId) testerBrowser.sessions.back(state.activeId);         return; }
    if (e.altKey  && e.key === 'ArrowRight')       { e.preventDefault(); if (state.activeId) testerBrowser.sessions.forward(state.activeId);      return; }
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') { e.preventDefault(); handleShortcut(`switchTab:${e.key}`); return; }
  });

  testerBrowser.sessions.onShortcut((key) => handleShortcut(key));
}
