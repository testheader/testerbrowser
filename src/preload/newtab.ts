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

// Bridges alert()/confirm()/prompt() to the main process for every tab's
// WebContentsView (this preload is attached to real pages, not just
// newtab.html). This can't be a plain `window.alert = ...` assignment here:
// with contextIsolation on, this preload's `window` is a separate JS context
// from the page's real one, so a direct overwrite would only mutate our own
// isolated copy and never touch what the page's own `alert()` calls actually
// invoke. contextBridge is the one thing that genuinely crosses that
// boundary — sessionManager.ts's CDP Page.addScriptToEvaluateOnNewDocument
// injects a small script into the page's *real* main world that reassigns
// window.alert/confirm/prompt to call through this bridge.
//
// Chromium's default dialogs matter here because they're modal to the whole
// native window (see CLAUDE.md's BrowserView-input-swallowing gotcha), which
// would freeze the entire browser chrome — other tabs, the URL bar,
// everything — just because one page called alert(). Routing through
// sendSync to the main process instead shows a non-blocking notification
// (see sessionManager.ts requestDialog / renderer's dialogs.js), while still
// blocking only the calling page's own script, same as real
// alert()/confirm()/prompt() semantics.
contextBridge.exposeInMainWorld('__tbDialogs', {
  alertSync: (message: string): void => {
    ipcRenderer.sendSync('dialog:alert', message);
  },
  confirmSync: (message: string): boolean => {
    return ipcRenderer.sendSync('dialog:confirm', message);
  },
  promptSync: (message: string, defaultValue: string): string | null => {
    return ipcRenderer.sendSync('dialog:prompt', message, defaultValue);
  },
});
