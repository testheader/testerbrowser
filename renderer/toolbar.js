/* global testerBrowser */
import { getActiveId, isTabLoading } from './tabs.js';
import { looksLikeUrl, buildSearchUrl } from './utils.js';
import { updateUrlbarSecurity } from './urlbar-security.js';
import { openBugReport } from './bugreport.js';

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
    btn.innerHTML = '<i class="icon-x" aria-hidden="true"></i>';
    btn.title     = 'Stop loading (Esc)';
    btn.setAttribute('aria-label', 'Stop loading');
    btn.onclick   = () => activeId && testerBrowser.sessions.stop(activeId);
  } else {
    btn.innerHTML = '<i class="icon-rotate-cw" aria-hidden="true"></i>';
    btn.title     = 'Reload (F5)';
    btn.setAttribute('aria-label', 'Reload');
    btn.onclick   = () => activeId && testerBrowser.sessions.reload(activeId);
  }
}

export function updateNavButtons() {
  const ns = navState[getActiveId()] || {};
  /** @type {HTMLButtonElement} */ (document.getElementById('backBtn')).disabled = !ns.canBack;
  /** @type {HTMLButtonElement} */ (document.getElementById('fwdBtn')).disabled  = !ns.canForward;
}

export function updateZoomDisplay(zoom) {
  const el = document.getElementById('zoomIndicator');
  const pct = Math.round(zoom * 100);
  el.textContent = pct + '%';
  // Only worth showing once the page is actually zoomed.
  el.hidden = pct === 100;
}

// #295: "Session N · Persistent|In-memory" chip at the right of the URL bar.
// `session` is the active tab's list entry (name/color/persistent), or
// undefined when there is no active tab.
export function updateSessionChip(session) {
  const chip = document.getElementById('sessionChip');
  if (!session) { chip.hidden = true; return; }
  chip.hidden = false;
  document.getElementById('sessionChipDot').style.background = session.color || '';
  document.getElementById('sessionChipText').textContent =
    `${session.name} · ${session.persistent ? 'Persistent' : 'In-memory'}`;
}

export function initToolbar() {
  document.getElementById('zoomIndicator').onclick = () =>
    getActiveId() && testerBrowser.sessions.resetZoom(getActiveId());

  /** @type {HTMLButtonElement} */ (document.getElementById('backBtn')).onclick     = () => getActiveId() && testerBrowser.sessions.back(getActiveId());
  /** @type {HTMLButtonElement} */ (document.getElementById('fwdBtn')).onclick      = () => getActiveId() && testerBrowser.sessions.forward(getActiveId());
  document.getElementById('bugReportBtn').onclick = () => openBugReport();

  document.getElementById('urlbar').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && getActiveId()) {
      const input = /** @type {HTMLInputElement} */ (e.target).value;
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
      // Update #urlbarDisplay with what was just submitted before blurring —
      // blur() makes it visible immediately, while the 'session:navigated'
      // event that would otherwise refresh it only arrives once the actual
      // navigation completes, leaving the previous URL showing until then.
      updateUrlbarSecurity(navigatedUrl);
      /** @type {HTMLElement} */ (e.target).blur();
    }
    if (e.key === 'Escape') /** @type {HTMLElement} */ (e.target).blur();
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
