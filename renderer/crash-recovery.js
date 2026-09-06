/* global testerBrowser */
// Shows a per-tab "Oops" overlay in place of a crashed tab's WebContentsView
// (which the main process removes from the window the moment the renderer
// process goes away — see sessionManager.ts's render-process-gone handler)
// instead of leaving a dead/blank surface, and without affecting any other
// tab or the rest of the app.
import { state } from './state.js';

const crashedIds = new Set();

export function syncCrashOverlay() {
  document.getElementById('crashOverlay').hidden = !crashedIds.has(state.activeId);
}

export function initCrashRecovery() {
  testerBrowser.sessions.onCrashed(({ id }) => {
    crashedIds.add(id);
    syncCrashOverlay();
  });
  testerBrowser.sessions.onRecovered(({ id }) => {
    crashedIds.delete(id);
    syncCrashOverlay();
  });
  document.getElementById('crashReloadBtn').onclick = () => {
    if (state.activeId) testerBrowser.sessions.reload(state.activeId);
  };
}
