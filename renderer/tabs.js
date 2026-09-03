/* global testerBrowser */
import { state } from './state.js';
import { setLoadingBar, updateReloadBtn, updateNavButtons, updateZoomDisplay } from './toolbar.js';
import { updateBookmarkStar } from './bookmarks.js';
import { loadStoragePanel } from './storage.js';
import { refreshDiffPickers } from './diff.js';
import { updateUrlbarSecurity } from './urlbar-security.js';
import { reloadA11yIfLoaded } from './a11y.js';
import { loadRules } from './resilience.js';
import { refreshVR, clearVRSession } from './visual-regression.js';

export function insertAfterActive(id) {
  const idx = state.activeId ? state.tabOrder.indexOf(state.activeId) : -1;
  if (idx === -1) state.tabOrder.push(id);
  else state.tabOrder.splice(idx + 1, 0, id);
}

export function recordVisit(id) {
  state.mruStack = [id, ...state.mruStack.filter((x) => x !== id)];
}

export async function switchToSession(id) {
  state.activeId = id;
  state.lastTs   = 0;
  state.timelineEvents.length = 0;
  document.getElementById('timelinePanel').innerHTML = '';
  if (state.activeConsoleTab === 'storage') loadStoragePanel();
  if (state.activeConsoleTab === 'a11y') reloadA11yIfLoaded();
  if (state.activeConsoleTab === 'resilience') loadRules();
  if (state.activeConsoleTab === 'vr') refreshVR();
  recordVisit(id);
  await testerBrowser.sessions.switchTo(id);
  updateNavButtons();
  updateReloadBtn();
  setLoadingBar(state.tabLoading[id] || false);
  updateZoomDisplay(1); // session:zoomChanged will arrive immediately after switchTo
  await refreshTabs();
}

export function cycleTab(reverse) {
  if (state.mruStack.length < 2) return;
  switchToSession(reverse ? state.mruStack[state.mruStack.length - 1] : state.mruStack[1]);
}

export async function refreshTabs() {
  const sessions   = await testerBrowser.sessions.list();
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  refreshDiffPickers();

  state.tabOrder = state.tabOrder.filter((id) => sessionMap.has(id));
  for (const s of sessions) if (!state.tabOrder.includes(s.id)) state.tabOrder.push(s.id);

  const tabsEl = document.getElementById('tabs');
  tabsEl.querySelectorAll('.tab, .tab-group-add').forEach((el) => el.remove());

  // Group consecutive same-partition tabs into runs
  const runs = [];
  for (const id of state.tabOrder) {
    const s = sessionMap.get(id);
    const last = runs[runs.length - 1];
    if (last && last.partition === s.partition) last.ids.push(id);
    else runs.push({ partition: s.partition, color: s.color, name: s.name, ids: [id] });
  }

  for (const run of runs) {
  for (const id of run.ids) {
    const s = sessionMap.get(id);

    const tab = document.createElement('span');
    tab.className  = 'tab' + (s.id === state.activeId ? ' active' : '');
    tab.dataset.id = s.id;
    if (s.color) tab.style.setProperty('--tab-color', s.color);

    if (state.tabLoading[s.id]) {
      const spinner = document.createElement('span');
      spinner.className = 'tab-spinner';
      tab.appendChild(spinner);
    } else if (state.tabFavicons[s.id]) {
      const img = document.createElement('img');
      img.className = 'tab-favicon';
      img.src = state.tabFavicons[s.id];
      img.onerror = () => img.remove();
      tab.appendChild(img);
    } else {
      const dot = document.createElement('span');
      dot.className = 'tab-dot ' + (s.persistent ? 'persistent' : 'ephemeral');
      dot.title     = s.persistent ? 'Persistent session' : 'In-memory session';
      tab.appendChild(dot);
    }

    if (s.pinned) {
      const pin = document.createElement('span');
      pin.className   = 'tab-pin';
      pin.textContent = '📌';
      tab.appendChild(pin);
    }

    const name = document.createElement('span');
    name.className   = 'tab-name';
    name.textContent = s.name;
    name.title       = state.tabTitles[s.id] || s.name;
    name.onclick = () => {
      clearTimeout(state.tabClickTimer);
      state.tabClickTimer = setTimeout(() => switchToSession(s.id), 250);
    };
    name.ondblclick = (e) => {
      e.stopPropagation();
      clearTimeout(state.tabClickTimer);
      startRename(s.id, name);
    };
    tab.appendChild(name);

    if (!s.pinned) {
      const x = document.createElement('span');
      x.className   = 'tab-close';
      x.textContent = '×';
      x.title       = 'Close (Ctrl+W)';
      x.onclick     = (e) => { e.stopPropagation(); closeTab(s.id); };
      tab.appendChild(x);
    }

    tab.oncontextmenu = (e) => { e.preventDefault(); testerBrowser.sessions.contextMenu(s.id); };

    tab.draggable = true;
    tab.addEventListener('dragstart', (e) => {
      state.dragSourceId = s.id;
      tab.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    tab.addEventListener('dragend', () => {
      state.dragSourceId = null;
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('dragging', 'drag-left', 'drag-right'));
    });
    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!state.dragSourceId || state.dragSourceId === s.id) return;
      const mid = tab.getBoundingClientRect().left + tab.offsetWidth / 2;
      tab.classList.toggle('drag-left',  e.clientX <= mid);
      tab.classList.toggle('drag-right', e.clientX >  mid);
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drag-left', 'drag-right'));
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drag-left', 'drag-right');
      if (!state.dragSourceId || state.dragSourceId === s.id) return;
      const before = e.clientX <= tab.getBoundingClientRect().left + tab.offsetWidth / 2;
      state.tabOrder = state.tabOrder.filter((x) => x !== state.dragSourceId);
      const to = state.tabOrder.indexOf(s.id);
      state.tabOrder.splice(before ? to : to + 1, 0, state.dragSourceId);
      refreshTabs();
    });

    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1 && !s.pinned) { e.preventDefault(); e.stopPropagation(); closeTab(s.id); }
    });

    tabsEl.insertBefore(tab, document.getElementById('newSessionBtn'));
  } // end for id of run.ids

  const addBtn = document.createElement('span');
  addBtn.className = 'tab-group-add';
  addBtn.title = 'New tab in this session';
  addBtn.textContent = '+';
  addBtn.onclick = async () => {
    const lastId = run.ids[run.ids.length - 1];
    const id = await testerBrowser.sessions.create(run.name, { partition: run.partition, color: run.color });
    const idx = state.tabOrder.indexOf(lastId);
    if (idx === -1) state.tabOrder.push(id);
    else state.tabOrder.splice(idx + 1, 0, id);
    await switchToSession(id);
  };
  tabsEl.insertBefore(addBtn, document.getElementById('newSessionBtn'));
  } // end for run of runs

  state.mruStack = state.mruStack.filter((id) => sessionMap.has(id));
  if (!state.activeId && sessions.length) { state.activeId = sessions[0].id; recordVisit(state.activeId); }

  const active = sessionMap.get(state.activeId);
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
    await testerBrowser.sessions.rename(id, input.value.trim() || original);
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

  if (s) state.closedTabs.push({ name: s.name, url: s.url || 'https://example.com', partition: s.partition, color: s.color });
  if (state.closedTabs.length > 20) state.closedTabs.shift();

  await testerBrowser.sessions.destroy(id);
  state.tabOrder = state.tabOrder.filter((x) => x !== id);
  state.mruStack = state.mruStack.filter((x) => x !== id);
  delete state.tabFavicons[id];
  delete state.tabTitles[id];
  delete state.navState[id];
  delete state.tabLoading[id];
  clearVRSession(id);

  if (state.activeId === id) {
    state.activeId = null;
    const next = state.mruStack[0] ?? null;
    if (next) { await switchToSession(next); return; }
  }
  refreshTabs();
}

export async function reopenTab() {
  const entry = state.closedTabs.pop();
  if (!entry) return;
  const id = await testerBrowser.sessions.reopen(entry);
  if (!id) return;
  insertAfterActive(id);
  await switchToSession(id);
}

export function updateTabLoadingVisual(tab, id) {
  const existing = tab.querySelector('.tab-spinner, .tab-favicon, .tab-dot');
  if (!existing) return;
  if (state.tabLoading[id]) {
    if (!tab.querySelector('.tab-spinner')) {
      const spinner = document.createElement('span');
      spinner.className = 'tab-spinner';
      existing.replaceWith(spinner);
    }
  } else {
    if (tab.querySelector('.tab-spinner')) {
      if (state.tabFavicons[id]) {
        const img = document.createElement('img');
        img.className = 'tab-favicon';
        img.src = state.tabFavicons[id];
        img.onerror = () => img.remove();
        tab.querySelector('.tab-spinner').replaceWith(img);
      } else {
        refreshTabs();
      }
    }
  }
}

export async function newSession({ persistent = true } = {}) {
  state.sessionCounter++;
  const name = persistent ? `Session ${state.sessionCounter}` : `Temp ${state.sessionCounter}`;
  const id = await testerBrowser.sessions.create(name, { persistent });
  insertAfterActive(id);
  await switchToSession(id);
  return id;
}

export function initTabs() {
  // Persistent by default: an ephemeral tab and everything opened from it is
  // discarded on quit, which is not what a "+" button implies.
  document.getElementById('newSessionBtn').onclick = (e) => newSession({ persistent: !e.shiftKey });

  testerBrowser.sessions.onTitleUpdated(({ id, title }) => {
    state.tabTitles[id] = title;
    const nameEl = document.querySelector(`.tab[data-id="${id}"] .tab-name`);
    if (nameEl) nameEl.title = title;
  });

  testerBrowser.sessions.onFaviconUpdated(({ id, favicon }) => {
    state.tabFavicons[id] = favicon;
    refreshTabs();
  });

  testerBrowser.sessions.onTabCycle(({ reverse }) => cycleTab(reverse));

  testerBrowser.sessions.onNewTab(({ id }) => { insertAfterActive(id); switchToSession(id); });
}
