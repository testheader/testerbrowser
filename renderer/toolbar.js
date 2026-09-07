/* global testerBrowser */
import { getActiveId, isTabLoading } from './tabs.js';
import { looksLikeUrl, buildSearchUrl } from './utils.js';

// navState (per-tab back/forward availability) and urlHistory (the URL bar's
// autocomplete list) are both toolbar-only concerns — nothing outside this
// file reads or writes them, aside from tabs.js clearing a closed tab's
// navState entry via clearNavState().
const navState = {};
let urlHistory = [];

export function clearNavState(id) { delete navState[id]; }

export function setLoadingBar(loading) {
  document.getElementById('loadingBar').classList.toggle('loading', loading);
}

export function updateReloadBtn() {
  const btn = document.getElementById('reloadBtn');
  const activeId = getActiveId();
  if (isTabLoading(activeId)) {
    btn.innerHTML = '&#10005;';
    btn.title     = 'Stop loading (Esc)';
    btn.onclick   = () => activeId && testerBrowser.sessions.stop(activeId);
  } else {
    btn.innerHTML = '&#8635;';
    btn.title     = 'Reload (F5)';
    btn.onclick   = () => activeId && testerBrowser.sessions.reload(activeId);
  }
}

export function updateNavButtons() {
  const ns = navState[getActiveId()] || {};
  document.getElementById('backBtn').disabled = !ns.canBack;
  document.getElementById('fwdBtn').disabled  = !ns.canForward;
}

export function updateZoomDisplay(zoom) {
  const el = document.getElementById('zoomIndicator');
  el.textContent = Math.round(zoom * 100) + '%';
}

export function initToolbar() {
  document.getElementById('zoomIndicator').onclick = () =>
    getActiveId() && testerBrowser.sessions.resetZoom(getActiveId());

  document.getElementById('backBtn').onclick     = () => getActiveId() && testerBrowser.sessions.back(getActiveId());
  document.getElementById('fwdBtn').onclick      = () => getActiveId() && testerBrowser.sessions.forward(getActiveId());
  document.getElementById('devtoolsBtn').onclick = () => getActiveId() && testerBrowser.sessions.devtools(getActiveId());

  document.getElementById('urlbar').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && getActiveId()) {
      const input = e.target.value;
      let navigatedUrl;
      if (looksLikeUrl(input)) {
        navigatedUrl = /^https?:\/\//i.test(input) ? input : `https://${input}`;
      } else {
        const settings = await testerBrowser.settings.get();
        navigatedUrl = buildSearchUrl(settings.searchEngine, input);
      }
      await testerBrowser.sessions.navigate(getActiveId(), navigatedUrl);
      urlHistory = await testerBrowser.urlHistory.add(navigatedUrl);
      refreshUrlDatalist();
      e.target.blur();
    }
    if (e.key === 'Escape') e.target.blur();
  });

  testerBrowser.sessions.onNavState(({ id, canBack, canForward }) => {
    navState[id] = { canBack, canForward };
    if (id === getActiveId()) updateNavButtons();
  });

  testerBrowser.sessions.onZoomChanged(({ id, zoom }) => {
    if (id === getActiveId()) updateZoomDisplay(zoom);
  });
}

export async function loadUrlHistory() {
  urlHistory = await testerBrowser.urlHistory.get();
  refreshUrlDatalist();
}

function refreshUrlDatalist() {
  const dl = document.getElementById('urlHistoryList');
  dl.innerHTML = '';
  for (const url of urlHistory) {
    const opt = document.createElement('option');
    opt.value = url;
    dl.appendChild(opt);
  }
}
