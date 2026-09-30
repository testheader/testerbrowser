import { contextBridge, ipcRenderer } from 'electron';

// This preload rides on every tab's WebContentsView (a view's preload is fixed
// at creation, and a tab starts on the new-tab page then navigates to the site
// under test), but it re-runs for every document. Only expose the APIs to the
// bundled new-tab page itself, so a website under test never sees extra
// globals (window.speedDial, window.appSettings, …) that a normal browser
// wouldn't have. The main process still checks the sender on each call
// (isTrustedNewtabFrame); this check only keeps the page's environment clean.
function isNewtabPage(): boolean {
  if (location.protocol !== 'file:') return false;
  let pathname = location.pathname;
  try { pathname = decodeURIComponent(pathname); } catch { /* keep the raw pathname */ }
  return /[/\\]renderer[/\\]newtab\.html$/i.test(pathname);
}

if (isNewtabPage()) {
  contextBridge.exposeInMainWorld('speedDial', {
    getTiles: () => ipcRenderer.invoke('speeddial:get'),
    saveTiles: (tiles: unknown[]) => ipcRenderer.invoke('speeddial:set', tiles),
  });

  contextBridge.exposeInMainWorld('appTheme', {
    get: () => ipcRenderer.invoke('theme:get'),
    set: (scheme: string) => ipcRenderer.invoke('theme:set', scheme),
    onChange: (cb: (scheme: string) => void) => {
      ipcRenderer.on('theme:changed', (_e, scheme: string) => cb(scheme));
    },
  });

  contextBridge.exposeInMainWorld('bookmarksApi', {
    list:        () => ipcRenderer.invoke('bookmarks:list'),
    remove:      (url: string) => ipcRenderer.invoke('bookmarks:remove', url),
    listFolders: () => ipcRenderer.invoke('bookmarks:listFolders'),
  });

  contextBridge.exposeInMainWorld('appSettings', {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch),
  });

  contextBridge.exposeInMainWorld('appInfo', {
    getVersionInfo: () => ipcRenderer.invoke('app:versionInfo'),
  });
}
