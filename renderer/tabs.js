/* global testerBrowser */
import { setLoadingBar, updateReloadBtn, updateNavButtons, updateZoomDisplay, clearNavState } from './toolbar.js';
import { updateBookmarkStar } from './bookmarks.js';
import { loadStoragePanel } from './storage.js';
import { refreshDiffPickers } from './diff.js';
import { refreshFollowPickers } from './followalong.js';
import { updateUrlbarSecurity } from './urlbar-security.js';
import { reloadA11yIfLoaded } from './a11y.js';
import { loadRules } from './resilience.js';
import { refreshVR, refreshVRComparePicker, clearVRSession } from './visual-regression.js';
import { clearSecurityFindings } from './security.js';
import { refreshTimelineNow, resetTimelineForNewSession } from './timeline.js';
import { getActiveConsoleTab } from './console-tabs.js';

// tabs.js owns every piece of per-tab bookkeeping: which tab is active, MRU
// order, drag/drop order, favicons, titles, loading state, and the closed-tab
// stack. Nothing outside this file mutates these directly — cross-module
// reads go through the accessors below, and mutation happens only through
// action functions (switchToSession, closeTab, etc.) or, for tabLoading,
// through setTabLoading (ipc-events.js is the one external writer).
let activeId       = null;
let sessionCounter  = 0;
let mruStack        = [];
let tabOrder         = [];
let dragSourceId     = null;
const tabFavicons    = {};
const tabTitles      = {};
const tabLoading     = {};
const closedTabs     = []; // [{ name, url, partition, color }] — most recent last

export function getActiveId() { return activeId; }
export function getTabOrder() { return tabOrder; }
export function getTabTitle(id) { return tabTitles[id]; }
export function isTabLoading(id) { return !!tabLoading[id]; }
export function setTabLoading(id, loading) { tabLoading[id] = loading; }

export async function insertAfterActive(id) {
  const sessions   = await testerBrowser.sessions.list();
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const partition  = sessionMap.get(id)?.partition;

  // Keep same-session tabs grouped: insert after the last tab sharing this
  // partition, wherever it sits, instead of always after the active tab.
  let idx = -1;
  if (partition) {
    for (let i = tabOrder.length - 1; i >= 0; i--) {
      const tid = tabOrder[i];
      if (tid !== id && sessionMap.get(tid)?.partition === partition) { idx = i; break; }
    }
  }
  if (idx === -1) idx = activeId ? tabOrder.indexOf(activeId) : -1;
  if (idx === -1) tabOrder.push(id);
  else tabOrder.splice(idx + 1, 0, id);
}

export function recordVisit(id) {
  mruStack = [id, ...mruStack.filter((x) => x !== id)];
}

export async function switchToSession(id) {
  activeId = id;
  resetTimelineForNewSession();
  const activeConsoleTab = getActiveConsoleTab();
  if (activeConsoleTab === 'storage') loadStoragePanel();
  if (activeConsoleTab === 'a11y') reloadA11yIfLoaded();
  if (activeConsoleTab === 'resilience') loadRules();
  if (activeConsoleTab === 'vr') refreshVR();
  if (activeConsoleTab === 'security') clearSecurityFindings();
  if (activeConsoleTab === 'console' || activeConsoleTab === 'network') refreshTimelineNow();
  recordVisit(id);
  await testerBrowser.sessions.switchTo(id);
  updateNavButtons();
  updateReloadBtn();
  setLoadingBar(tabLoading[id] || false);
  updateZoomDisplay(1); // session:zoomChanged will arrive immediately after switchTo
  await refreshTabs();
}

export function cycleTab(reverse) {
  if (mruStack.length < 2) return;
  switchToSession(reverse ? mruStack[mruStack.length - 1] : mruStack[1]);
}

// Builds the static skeleton for a tab that never changes for the life of
// that session id: structural children and event listeners. Called once per
// session id (see refreshTabs) so a tab's DOM node — and therefore its
// identity — survives every re-render after that. That matters for more
// than avoiding needless work: the double-click-to-rename handler below
// targets a specific captured node, and the browser's own dblclick
// detection requires both clicks of a double-click to land on the same
// node — swap in a lookalike replacement between the two clicks (which a
// full teardown-and-rebuild on every tab switch used to do) and the second
// click just reads as an unrelated single click.
function createTabElement(s) {
  const tab = document.createElement('span');
  tab.className  = 'tab';
  tab.dataset.id = s.id;

  const name = document.createElement('span');
  name.className = 'tab-name';
  name.onclick = () => switchToSession(s.id);
  name.ondblclick = (e) => { e.stopPropagation(); startRename(s.id, name); };
  tab.appendChild(name);

  tab.oncontextmenu = (e) => { e.preventDefault(); testerBrowser.sessions.contextMenu(s.id); };

  tab.draggable = true;
  tab.addEventListener('dragstart', (e) => {
    dragSourceId = s.id;
    tab.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  tab.addEventListener('dragend', () => {
    dragSourceId = null;
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('dragging', 'drag-left', 'drag-right'));
  });
  tab.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragSourceId || dragSourceId === s.id) return;
    const mid = tab.getBoundingClientRect().left + tab.offsetWidth / 2;
    tab.classList.toggle('drag-left',  e.clientX <= mid);
    tab.classList.toggle('drag-right', e.clientX >  mid);
  });
  tab.addEventListener('dragleave', () => tab.classList.remove('drag-left', 'drag-right'));
  tab.addEventListener('drop', (e) => {
    e.preventDefault();
    tab.classList.remove('drag-left', 'drag-right');
    if (!dragSourceId || dragSourceId === s.id) return;
    const before = e.clientX <= tab.getBoundingClientRect().left + tab.offsetWidth / 2;
    tabOrder = tabOrder.filter((x) => x !== dragSourceId);
    const to = tabOrder.indexOf(s.id);
    tabOrder.splice(before ? to : to + 1, 0, dragSourceId);
    refreshTabs();
  });

  // Pinned state can change without a full re-render happening in between,
  // so this reads state.dataset.pinned live rather than closing over s.pinned.
  tab.addEventListener('auxclick', (e) => {
    if (e.button === 1 && tab.dataset.pinned !== '1') { e.preventDefault(); e.stopPropagation(); closeTab(s.id); }
  });

  return tab;
}

function buildIndicator(s) {
  if (tabLoading[s.id]) {
    const spinner = document.createElement('span');
    spinner.className = 'tab-spinner';
    return spinner;
  }
  if (tabFavicons[s.id]) {
    const img = document.createElement('img');
    img.className = 'tab-favicon';
    img.src = tabFavicons[s.id];
    img.onerror = () => img.remove();
    return img;
  }
  const dot = document.createElement('span');
  dot.className = 'tab-dot ' + (s.persistent ? 'persistent' : 'ephemeral');
  dot.title     = s.persistent ? 'Persistent session' : 'In-memory session';
  return dot;
}

// Applies everything about a tab that CAN change between renders (active
// state, color, loading/favicon indicator, pin, name/title, close button).
// Runs on every render, including reused nodes, so a plain tab switch stays
// as cheap as flipping a class — no per-tab element churn.
function updateTabElement(tab, s) {
  tab.classList.toggle('active', s.id === activeId);
  if (s.color) tab.style.setProperty('--tab-color', s.color);
  tab.dataset.pinned = s.pinned ? '1' : '';

  const indicator = tab.querySelector('.tab-spinner, .tab-favicon, .tab-dot');
  const currentSrc = indicator?.tagName === 'IMG' ? indicator.src : null;
  const needsSwap =
    !indicator ||
    (tabLoading[s.id]  && !indicator.classList.contains('tab-spinner')) ||
    (!tabLoading[s.id] && tabFavicons[s.id] && currentSrc !== tabFavicons[s.id]) ||
    (!tabLoading[s.id] && !tabFavicons[s.id] && !indicator.classList.contains('tab-dot'));
  if (needsSwap) {
    const next = buildIndicator(s);
    if (indicator) indicator.replaceWith(next); else tab.insertBefore(next, tab.firstChild);
  }

  const name = tab.querySelector('.tab-name');
  let pin = tab.querySelector('.tab-pin');
  if (s.pinned && !pin) {
    pin = document.createElement('span');
    pin.className   = 'tab-pin';
    pin.textContent = '📌';
    tab.insertBefore(pin, name);
  } else if (!s.pinned && pin) {
    pin.remove();
  }

  name.textContent = s.name;
  name.title       = tabTitles[s.id] || s.name;

  let closeBtn = tab.querySelector('.tab-close');
  if (!s.pinned && !closeBtn) {
    closeBtn = document.createElement('span');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close (Ctrl+W)';
    closeBtn.onclick = (e) => { e.stopPropagation(); closeTab(s.id); };
    tab.appendChild(closeBtn);
  } else if (s.pinned && closeBtn) {
    closeBtn.remove();
  }
}

export async function refreshTabs() {
  const sessions   = await testerBrowser.sessions.list();
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  refreshDiffPickers();
  refreshFollowPickers();
  refreshVRComparePicker();

  tabOrder = tabOrder.filter((id) => sessionMap.has(id));
  for (const s of sessions) if (!tabOrder.includes(s.id)) tabOrder.push(s.id);
  testerBrowser.sessions.setTabOrder(tabOrder);

  const tabsEl = document.getElementById('tabs');
  const newSessionBtn = document.getElementById('newSessionBtn');

  const existingTabs = new Map();
  tabsEl.querySelectorAll('.tab').forEach((el) => existingTabs.set(el.dataset.id, el));
  for (const [id, el] of existingTabs) if (!sessionMap.has(id)) el.remove();
  tabsEl.querySelectorAll('.tab-group-add').forEach((el) => el.remove());

  // Group consecutive same-partition tabs into runs
  const runs = [];
  for (const id of tabOrder) {
    const s = sessionMap.get(id);
    const last = runs[runs.length - 1];
    if (last && last.partition === s.partition) last.ids.push(id);
    else runs.push({ partition: s.partition, color: s.color, name: s.name, ids: [id] });
  }

  for (const run of runs) {
    for (const id of run.ids) {
      const s = sessionMap.get(id);
      const tab = existingTabs.get(id) ?? createTabElement(s);
      updateTabElement(tab, s);
      tabsEl.insertBefore(tab, newSessionBtn);
    }

    const addBtn = document.createElement('span');
    addBtn.className = 'tab-group-add';
    addBtn.title = 'New tab in this session';
    addBtn.textContent = '+';
    addBtn.onclick = async () => {
      const lastId = run.ids[run.ids.length - 1];
      const id = await testerBrowser.sessions.create(run.name, { partition: run.partition, color: run.color });
      const idx = tabOrder.indexOf(lastId);
      if (idx === -1) tabOrder.push(id);
      else tabOrder.splice(idx + 1, 0, id);
      await switchToSession(id);
    };
    tabsEl.insertBefore(addBtn, newSessionBtn);
  }

  mruStack = mruStack.filter((id) => sessionMap.has(id));
  if (!activeId && sessions.length) { activeId = sessions[0].id; recordVisit(activeId); }

  const active = sessionMap.get(activeId);
  if (active) {
    document.getElementById('urlbar').value = active.url || '';
    updateUrlbarSecurity(active.url || '');
    updateBookmarkStar();
  }
  document.body.style.setProperty('--active-tab-color', (active && active.color) || '#4fc3f7');

  updateNavButtons();
}

export function startRename(id, nameEl) {
  const original = nameEl.textContent;
  const input = document.createElement('input');
  input.className = 'tab-rename-input';
  input.value = original;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const newName = input.value.trim() || original;
    // Restore the original (persistent, listener-bearing) name node right
    // away rather than leaving that to the refreshTabs() below — tab
    // elements are reused across renders now (see refreshTabs/updateTabElement),
    // so nothing else will swap this input back out for us.
    input.replaceWith(nameEl);
    nameEl.textContent = newName;
    await testerBrowser.sessions.rename(id, newName);
    refreshTabs();
  };
  const cancel = () => { if (done) return; done = true; input.replaceWith(nameEl); };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
}

export async function closeTab(id) {
  const sessions = await testerBrowser.sessions.list();
  const s = sessions.find((x) => x.id === id);

  if (s && !s.persistent) {
    const notes = await testerBrowser.sessions.getNotes(id);
    if (notes && notes.trim()) {
      const ok = confirm(`"${s.name}" is an in-memory session with notes.\n\nNotes will be lost when the tab is closed. Close anyway?`);
      if (!ok) return;
    }
  }

  if (s) closedTabs.push({ name: s.name, url: s.url || 'https://example.com', partition: s.partition, color: s.color });
  if (closedTabs.length > 20) closedTabs.shift();

  await testerBrowser.sessions.destroy(id);
  tabOrder = tabOrder.filter((x) => x !== id);
  mruStack = mruStack.filter((x) => x !== id);
  delete tabFavicons[id];
  delete tabTitles[id];
  clearNavState(id);
  delete tabLoading[id];
  clearVRSession(id);

  if (activeId === id) {
    activeId = null;
    const next = mruStack[0] ?? null;
    if (next) { await switchToSession(next); return; }
  }
  refreshTabs();
}

export async function reopenTab() {
  const entry = closedTabs.pop();
  if (!entry) return;
  const id = await testerBrowser.sessions.reopen(entry);
  if (!id) return;
  await insertAfterActive(id);
  await switchToSession(id);
}

export function updateTabLoadingVisual(tab, id) {
  const existing = tab.querySelector('.tab-spinner, .tab-favicon, .tab-dot');
  if (!existing) return;
  if (tabLoading[id]) {
    if (!tab.querySelector('.tab-spinner')) {
      const spinner = document.createElement('span');
      spinner.className = 'tab-spinner';
      existing.replaceWith(spinner);
    }
  } else {
    if (tab.querySelector('.tab-spinner')) {
      if (tabFavicons[id]) {
        const img = document.createElement('img');
        img.className = 'tab-favicon';
        img.src = tabFavicons[id];
        img.onerror = () => img.remove();
        tab.querySelector('.tab-spinner').replaceWith(img);
      } else {
        refreshTabs();
      }
    }
  }
}

export async function newSession({ persistent = true } = {}) {
  sessionCounter++;
  const name = persistent ? `Session ${sessionCounter}` : `Temp ${sessionCounter}`;
  const id = await testerBrowser.sessions.create(name, { persistent });
  await insertAfterActive(id);
  await switchToSession(id);
  return id;
}

export function initTabs() {
  // Persistent by default: an ephemeral tab and everything opened from it is
  // discarded on quit, which is not what a "+" button implies.
  document.getElementById('newSessionBtn').onclick = (e) => newSession({ persistent: !e.shiftKey });

  testerBrowser.sessions.onTitleUpdated(({ id, title }) => {
    tabTitles[id] = title;
    const nameEl = document.querySelector(`.tab[data-id="${id}"] .tab-name`);
    if (nameEl) nameEl.title = title;
  });

  testerBrowser.sessions.onFaviconUpdated(({ id, favicon }) => {
    tabFavicons[id] = favicon;
    refreshTabs();
  });

  testerBrowser.sessions.onTabCycle(({ reverse }) => cycleTab(reverse));

  testerBrowser.sessions.onNewTab(async ({ id }) => { await insertAfterActive(id); switchToSession(id); });
}
