/* global testerBrowser */
import { state } from './state.js';
import { updateTopBarHeight } from './layout.js';

export async function loadBookmarks() {
  [state.bookmarks, state.bookmarkFolders] = await Promise.all([
    testerBrowser.bookmarks.list(),
    testerBrowser.bookmarks.listFolders(),
  ]);
  renderBookmarksBar();
  updateBookmarkStar();
}

function closeContextMenu() {
  document.getElementById('bmContextMenu')?.remove();
}

// A small floating menu used both for a bookmark/folder's right-click actions
// and for a folder's click-to-open contents list — same shape, different trigger.
function openContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.id = 'bmContextMenu';
  menu.className = 'bm-context-menu';
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'bm-context-sep';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'bm-context-item';
    row.textContent = item.label;
    row.onclick = (e) => { e.stopPropagation(); closeContextMenu(); item.onClick(); };
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  // Deferred so the click that opened the menu doesn't immediately close it.
  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

async function removeBookmark(url) {
  state.bookmarks = await testerBrowser.bookmarks.remove(url);
  renderBookmarksBar();
  updateBookmarkStar();
}

async function moveBookmark(url, folderId) {
  state.bookmarks = await testerBrowser.bookmarks.move(url, folderId);
  renderBookmarksBar();
}

function startInlineRename(labelEl, currentValue, onCommit) {
  const input = document.createElement('input');
  input.className = 'bm-rename-input';
  input.value = currentValue;
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const value = input.value.trim();
    if (value && value !== currentValue) await onCommit(value);
    renderBookmarksBar();
  };
  const cancel = () => { if (done) return; done = true; renderBookmarksBar(); };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());
}

function bookmarkContextItems(bm) {
  return [
    { label: 'Rename…', onClick: () => renameBookmarkInline(bm) },
    { separator: true },
    { label: bm.folderId ? 'Move to top level' : '✓ Top level', onClick: () => moveBookmark(bm.url, null) },
    ...state.bookmarkFolders.map((f) => ({
      label: (bm.folderId === f.id ? '✓ ' : '') + `Move to “${f.name}”`,
      onClick: () => moveBookmark(bm.url, f.id),
    })),
    { separator: true },
    { label: 'Remove', onClick: () => removeBookmark(bm.url) },
  ];
}

function renameBookmarkInline(bm) {
  const btn = document.querySelector(`.bm-btn[data-url="${CSS.escape(bm.url)}"]`);
  const label = btn?.querySelector('.bm-label');
  if (!btn || !label) return;
  startInlineRename(label, bm.title || bm.url, (title) => testerBrowser.bookmarks.rename(bm.url, title).then((bs) => { state.bookmarks = bs; }));
}

function renameFolderInline(folder) {
  const btn = document.querySelector(`.bm-folder-btn[data-folder-id="${CSS.escape(folder.id)}"]`);
  const label = btn?.querySelector('.bm-label');
  if (!btn || !label) return;
  startInlineRename(label, folder.name, (name) => testerBrowser.bookmarks.renameFolder(folder.id, name).then((fs) => { state.bookmarkFolders = fs; }));
}

function makeBookmarkButton(bm) {
  const btn = document.createElement('button');
  btn.className = 'bm-btn';
  btn.title     = bm.url;
  btn.dataset.url = bm.url;

  const label = document.createElement('span');
  label.className = 'bm-label';
  label.textContent = bm.title || bm.url;
  btn.appendChild(label);

  const rm = document.createElement('span');
  rm.className   = 'bm-remove';
  rm.textContent = '×';
  rm.title       = 'Remove bookmark';
  rm.onclick = (e) => { e.stopPropagation(); removeBookmark(bm.url); };
  btn.appendChild(rm);

  btn.onclick = (e) => { if (e.target !== rm) { state.activeId && testerBrowser.sessions.navigate(state.activeId, bm.url); } };
  btn.oncontextmenu = (e) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, bookmarkContextItems(bm));
  };
  return btn;
}

function makeFolderButton(folder, bookmarksInFolder) {
  const btn = document.createElement('button');
  btn.className = 'bm-btn bm-folder-btn';
  btn.title     = folder.name;
  btn.dataset.folderId = folder.id;

  const label = document.createElement('span');
  label.className = 'bm-label';
  label.textContent = folder.name;
  btn.appendChild(label);

  const caret = document.createElement('span');
  caret.className = 'bm-folder-caret';
  caret.textContent = '▾';
  btn.appendChild(caret);

  btn.onclick = (e) => {
    e.stopPropagation();
    const rect = btn.getBoundingClientRect();
    const items = bookmarksInFolder.length
      ? bookmarksInFolder.map((bm) => ({
          label: bm.title || bm.url,
          onClick: () => state.activeId && testerBrowser.sessions.navigate(state.activeId, bm.url),
        }))
      : [{ label: '(empty folder)', onClick: () => {} }];
    openContextMenu(rect.left, rect.bottom, items);
  };
  btn.oncontextmenu = (e) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Rename folder…', onClick: () => renameFolderInline(folder) },
      { label: 'Delete folder', onClick: () => removeFolder(folder.id) },
    ]);
  };
  return btn;
}

async function removeFolder(id) {
  await testerBrowser.bookmarks.removeFolder(id);
  [state.bookmarks, state.bookmarkFolders] = await Promise.all([
    testerBrowser.bookmarks.list(),
    testerBrowser.bookmarks.listFolders(),
  ]);
  renderBookmarksBar();
}

function startNewFolder(addBtn) {
  const input = document.createElement('input');
  input.className = 'bm-rename-input';
  input.placeholder = 'Folder name';
  addBtn.replaceWith(input);
  input.focus();
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const name = input.value.trim();
    if (name) state.bookmarkFolders = await testerBrowser.bookmarks.createFolder(name);
    renderBookmarksBar();
  };
  const cancel = () => { if (done) return; done = true; renderBookmarksBar(); };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
}

export function renderBookmarksBar() {
  const bar = document.getElementById('bookmarksBar');
  bar.innerHTML = '';

  for (const folder of state.bookmarkFolders) {
    const inFolder = state.bookmarks.filter((b) => b.folderId === folder.id);
    bar.appendChild(makeFolderButton(folder, inFolder));
  }

  for (const bm of state.bookmarks) {
    if (bm.folderId && state.bookmarkFolders.some((f) => f.id === bm.folderId)) continue;
    bar.appendChild(makeBookmarkButton(bm));
  }

  const addFolderBtn = document.createElement('button');
  addFolderBtn.className = 'bm-btn bm-add-folder-btn';
  addFolderBtn.title = 'New bookmark folder';
  addFolderBtn.textContent = '+ Folder';
  addFolderBtn.onclick = () => startNewFolder(addFolderBtn);
  bar.appendChild(addFolderBtn);
}

function isBookmarkableUrl(url) {
  return !!url && url !== 'https://example.com';
}

export function updateBookmarkStar() {
  const starBtn      = document.getElementById('bookmarkBtn');
  const currentUrl   = document.getElementById('urlbar').value;
  const bookmarkable = isBookmarkableUrl(currentUrl);
  const isBookmarked = bookmarkable && state.bookmarks.some(b => b.url === currentUrl);
  starBtn.innerHTML  = isBookmarked ? '&#9733;' : '&#9734;';
  starBtn.title      = bookmarkable
    ? (isBookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)')
    : 'Nothing to bookmark yet';
  starBtn.classList.toggle('bookmarked', isBookmarked);
  starBtn.disabled = !bookmarkable;
}

export async function toggleBookmark() {
  const url = document.getElementById('urlbar').value;
  if (!isBookmarkableUrl(url)) return;
  const tabEl    = document.querySelector(`.tab[data-id="${state.activeId}"] .tab-name`);
  const title    = state.tabTitles[state.activeId] || tabEl?.textContent || url;
  const isBookmarked = state.bookmarks.some(b => b.url === url);
  if (isBookmarked) {
    state.bookmarks = await testerBrowser.bookmarks.remove(url);
  } else {
    state.bookmarks = await testerBrowser.bookmarks.add(url, title);
  }
  renderBookmarksBar();
  updateBookmarkStar();
}

export function toggleBookmarksBar() {
  state.bookmarksBarVisible = !state.bookmarksBarVisible;
  document.getElementById('bookmarksBar').classList.toggle('open', state.bookmarksBarVisible);
  updateTopBarHeight();
}

export function initBookmarks() {
  document.getElementById('bookmarkBtn').onclick = () => toggleBookmark();
}
