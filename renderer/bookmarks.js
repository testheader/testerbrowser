/* global testerBrowser */
import { state } from './state.js';
import { updateTopBarHeight } from './layout.js';

export async function loadBookmarks() {
  state.bookmarks = await testerBrowser.bookmarks.list();
  renderBookmarksBar();
  updateBookmarkStar();
}

export function renderBookmarksBar() {
  const bar = document.getElementById('bookmarksBar');
  bar.innerHTML = '';
  for (const bm of state.bookmarks) {
    const btn = document.createElement('button');
    btn.className = 'bm-btn';
    btn.title     = bm.url;

    const label = document.createElement('span');
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0';
    label.textContent = bm.title || bm.url;
    btn.appendChild(label);

    const rm = document.createElement('span');
    rm.className   = 'bm-remove';
    rm.textContent = '×';
    rm.title       = 'Remove bookmark';
    rm.onclick = async (e) => {
      e.stopPropagation();
      state.bookmarks = await testerBrowser.bookmarks.remove(bm.url);
      renderBookmarksBar();
      updateBookmarkStar();
    };
    btn.appendChild(rm);
    btn.onclick = (e) => { if (e.target !== rm) { state.activeId && testerBrowser.sessions.navigate(state.activeId, bm.url); } };
    bar.appendChild(btn);
  }
}

export function updateBookmarkStar() {
  const starBtn    = document.getElementById('bookmarkBtn');
  const currentUrl = document.getElementById('urlbar').value;
  const isBookmarked = state.bookmarks.some(b => b.url === currentUrl);
  starBtn.innerHTML  = isBookmarked ? '&#9733;' : '&#9734;';
  starBtn.title      = isBookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
  starBtn.classList.toggle('bookmarked', isBookmarked);
}

export async function toggleBookmark() {
  const url = document.getElementById('urlbar').value;
  if (!url || url === 'https://example.com') return;
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
