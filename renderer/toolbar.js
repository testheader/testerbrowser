/* global testerBrowser */
import { state } from './state.js';

export function setLoadingBar(loading) {
  document.getElementById('loadingBar').classList.toggle('loading', loading);
}

export function updateReloadBtn() {
  const btn = document.getElementById('reloadBtn');
  if (state.tabLoading[state.activeId]) {
    btn.innerHTML = '&#10005;';
    btn.title     = 'Stop loading (Esc)';
    btn.onclick   = () => state.activeId && testerBrowser.sessions.stop(state.activeId);
  } else {
    btn.innerHTML = '&#8635;';
    btn.title     = 'Reload (F5)';
    btn.onclick   = () => state.activeId && testerBrowser.sessions.reload(state.activeId);
  }
}

export function updateNavButtons() {
  const ns = state.navState[state.activeId] || {};
  document.getElementById('backBtn').disabled = !ns.canBack;
  document.getElementById('fwdBtn').disabled  = !ns.canForward;
}

export function updateZoomDisplay(zoom) {
  const el = document.getElementById('zoomIndicator');
  el.textContent = Math.round(zoom * 100) + '%';
}

export function initToolbar() {
  document.getElementById('zoomIndicator').onclick = () =>
    state.activeId && testerBrowser.sessions.resetZoom(state.activeId);

  document.getElementById('backBtn').onclick     = () => state.activeId && testerBrowser.sessions.back(state.activeId);
  document.getElementById('fwdBtn').onclick      = () => state.activeId && testerBrowser.sessions.forward(state.activeId);
  document.getElementById('devtoolsBtn').onclick = () => state.activeId && testerBrowser.sessions.devtools(state.activeId);

  document.getElementById('urlbar').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && state.activeId) {
      const url = e.target.value;
      await testerBrowser.sessions.navigate(state.activeId, url);
      const fullUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      state.urlHistory = await testerBrowser.urlHistory.add(fullUrl);
      refreshUrlDatalist();
      e.target.blur();
    }
    if (e.key === 'Escape') e.target.blur();
  });

  testerBrowser.sessions.onNavState(({ id, canBack, canForward }) => {
    state.navState[id] = { canBack, canForward };
    if (id === state.activeId) updateNavButtons();
  });

  testerBrowser.sessions.onZoomChanged(({ id, zoom }) => {
    if (id === state.activeId) updateZoomDisplay(zoom);
  });
}

export async function loadUrlHistory() {
  state.urlHistory = await testerBrowser.urlHistory.get();
  refreshUrlDatalist();
}

function refreshUrlDatalist() {
  const dl = document.getElementById('urlHistoryList');
  dl.innerHTML = '';
  for (const url of state.urlHistory) {
    const opt = document.createElement('option');
    opt.value = url;
    dl.appendChild(opt);
  }
}
