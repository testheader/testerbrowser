import { ipcMain } from 'electron';
import type { AppDeps, Bookmark, BookmarkStore, BookmarkFoldersStore, UrlHistoryStore, SpeedDialStore, SpeedDialTile } from './deps';

export interface BookmarksIpcStores {
  bookmarkStore: BookmarkStore;
  bookmarkFoldersStore: BookmarkFoldersStore;
  urlHistoryStore: UrlHistoryStore;
  speedDialStore: SpeedDialStore;
}

/** Bookmarks bar/folders, URL autocomplete history, and new-tab speed-dial IPC. */
export function registerBookmarksIpc(deps: AppDeps, stores: BookmarksIpcStores): void {
  const { rejectUntrustedSender } = deps;
  const { bookmarkStore, bookmarkFoldersStore, urlHistoryStore, speedDialStore } = stores;

  ipcMain.handle('bookmarks:list',   (e) => rejectUntrustedSender(e, 'bookmarks:list') ? [] : bookmarkStore.get());
  ipcMain.handle('bookmarks:add',    (e, url: string, title: string) => {
    if (rejectUntrustedSender(e, 'bookmarks:add')) return;
    return bookmarkStore.update(bs => [{ url, title, addedAt: Date.now(), folderId: null }, ...bs.filter(b => b.url !== url)]);
  });
  ipcMain.handle('bookmarks:remove', (e, url: string) => {
    if (rejectUntrustedSender(e, 'bookmarks:remove')) return;
    return bookmarkStore.update(bs => bs.filter(b => b.url !== url));
  });
  ipcMain.handle('bookmarks:rename', (e, url: string, title: string) => {
    if (rejectUntrustedSender(e, 'bookmarks:rename')) return;
    return bookmarkStore.update(bs => bs.map(b => (b.url === url ? { ...b, title } : b)));
  });
  ipcMain.handle('bookmarks:move', (e, url: string, folderId: string | null) => {
    if (rejectUntrustedSender(e, 'bookmarks:move')) return;
    return bookmarkStore.update((bs: Bookmark[]) => bs.map(b => (b.url === url ? { ...b, folderId } : b)));
  });

  ipcMain.handle('bookmarks:listFolders', (e) => rejectUntrustedSender(e, 'bookmarks:listFolders') ? [] : bookmarkFoldersStore.get());
  ipcMain.handle('bookmarks:createFolder', (e, name: string) => {
    if (rejectUntrustedSender(e, 'bookmarks:createFolder')) return;
    return bookmarkFoldersStore.update(fs => [
      ...fs,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name, createdAt: Date.now() },
    ]);
  });
  ipcMain.handle('bookmarks:renameFolder', (e, id: string, name: string) => {
    if (rejectUntrustedSender(e, 'bookmarks:renameFolder')) return;
    return bookmarkFoldersStore.update(fs => fs.map(f => (f.id === id ? { ...f, name } : f)));
  });
  ipcMain.handle('bookmarks:removeFolder', (e, id: string) => {
    if (rejectUntrustedSender(e, 'bookmarks:removeFolder')) return;
    // Bookmarks inside the deleted folder move back to the top level rather than being lost.
    bookmarkStore.update((bs: Bookmark[]) => bs.map(b => (b.folderId === id ? { ...b, folderId: null } : b)));
    return bookmarkFoldersStore.update(fs => fs.filter(f => f.id !== id));
  });

  ipcMain.handle('urlHistory:get', () => urlHistoryStore.get());
  ipcMain.handle('urlHistory:add', (_e, url: string) => {
    if (!url) return urlHistoryStore.get();
    return urlHistoryStore.update(h => [url, ...h.filter(u => u !== url)].slice(0, 500));
  });

  ipcMain.handle('speeddial:get', (e) => rejectUntrustedSender(e, 'speeddial:get') ? [] : speedDialStore.get());
  ipcMain.handle('speeddial:set', (e, tiles: unknown) => {
    if (rejectUntrustedSender(e, 'speeddial:set')) return;
    if (!Array.isArray(tiles) || tiles.length > 100) return;
    const sanitized: SpeedDialTile[] = (tiles as unknown[])
      .filter((t): t is Record<string, unknown> => t !== null && typeof t === 'object')
      .map(t => ({
        id:    String(t.id    ?? '').slice(0, 64),
        title: String(t.title ?? '').slice(0, 200),
        // Only allow http/https URLs — drop anything else
        url:   /^https?:\/\//i.test(String(t.url ?? '')) ? String(t.url).slice(0, 2048) : 'about:blank',
      }));
    speedDialStore.set(sanitized);
  });
}
