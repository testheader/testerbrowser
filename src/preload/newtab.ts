import { contextBridge, ipcRenderer } from 'electron';

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
