import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('testerBrowser', {
  sessions: {
    list:        () => ipcRenderer.invoke('sessions:list'),
    create:      (name: string, opts?: { persistent?: boolean; startUrl?: string }) =>
                   ipcRenderer.invoke('sessions:create', name, opts),
    switchTo:    (id: string) => ipcRenderer.invoke('sessions:switch', id),
    navigate:    (id: string, url: string) => ipcRenderer.invoke('sessions:navigate', id, url),
    clone:       (sourceId: string, newName: string) => ipcRenderer.invoke('sessions:clone', sourceId, newName),
    destroy:     (id: string) => ipcRenderer.invoke('sessions:destroy', id),
    rename:      (id: string, name: string) => ipcRenderer.invoke('sessions:rename', id, name),
    pin:         (id: string, pinned: boolean) => ipcRenderer.invoke('sessions:pin', id, pinned),
    reopen:      (opts: { name: string; url: string; partition: string }) => ipcRenderer.invoke('sessions:reopen', opts),
    back:        (id: string) => ipcRenderer.invoke('sessions:back', id),
    forward:     (id: string) => ipcRenderer.invoke('sessions:forward', id),
    reload:      (id: string) => ipcRenderer.invoke('sessions:reload', id),
    stop:        (id: string) => ipcRenderer.invoke('sessions:stop', id),
    setZoom:     (id: string, delta: number) => ipcRenderer.invoke('sessions:setZoom', id, delta),
    resetZoom:   (id: string) => ipcRenderer.invoke('sessions:resetZoom', id),
    getZoom:     (id: string) => ipcRenderer.invoke('sessions:getZoom', id),
    devtools:    (id: string) => ipcRenderer.invoke('devtools:toggle', id),
    contextMenu: (id: string) => ipcRenderer.invoke('sessions:contextMenu', id),
    findInPage:  (id: string, text: string, forward: boolean, findNext: boolean) =>
                   ipcRenderer.invoke('find:start', id, text, forward, findNext),
    stopFind:    (id: string) => ipcRenderer.invoke('find:stop', id),
    getNotes:        (id: string) => ipcRenderer.invoke('sessions:notes:get', id),
    setNotes:        (id: string, notes: string) => ipcRenderer.invoke('sessions:notes:set', id, notes),
    getCookies:      (id: string) => ipcRenderer.invoke('sessions:getCookies', id),
    getLocalStorage: (id: string) => ipcRenderer.invoke('sessions:getLocalStorage', id),

    onNavigated: (cb: (d: { id: string; url: string }) => void) => {
      ipcRenderer.removeAllListeners('session:navigated');
      ipcRenderer.on('session:navigated', (_e, d) => cb(d));
    },
    onNavState: (cb: (d: { id: string; canBack: boolean; canForward: boolean }) => void) => {
      ipcRenderer.removeAllListeners('session:navState');
      ipcRenderer.on('session:navState', (_e, d) => cb(d));
    },
    onTitleUpdated: (cb: (d: { id: string; title: string }) => void) => {
      ipcRenderer.removeAllListeners('session:titleUpdated');
      ipcRenderer.on('session:titleUpdated', (_e, d) => cb(d));
    },
    onFaviconUpdated: (cb: (d: { id: string; favicon: string }) => void) => {
      ipcRenderer.removeAllListeners('session:faviconUpdated');
      ipcRenderer.on('session:faviconUpdated', (_e, d) => cb(d));
    },
    onTabCycle: (cb: (d: { reverse: boolean }) => void) => {
      ipcRenderer.removeAllListeners('tabs:cycle');
      ipcRenderer.on('tabs:cycle', (_e, d) => cb(d));
    },
    onNewTab: (cb: (d: { id: string }) => void) => {
      ipcRenderer.removeAllListeners('session:newTab');
      ipcRenderer.on('session:newTab', (_e, d) => cb(d));
    },
    onTabAction: (cb: (d: { action: string; id: string }) => void) => {
      ipcRenderer.removeAllListeners('tab:action');
      ipcRenderer.on('tab:action', (_e, d) => cb(d));
    },
    onFindResult: (cb: (d: { id: string; matches: number; activeMatch: number }) => void) => {
      ipcRenderer.removeAllListeners('find:result');
      ipcRenderer.on('find:result', (_e, d) => cb(d));
    },
    onShortcut: (cb: (key: string) => void) => {
      ipcRenderer.removeAllListeners('app:shortcut');
      ipcRenderer.on('app:shortcut', (_e, key) => cb(key));
    },
    onLoading: (cb: (d: { id: string; loading: boolean }) => void) => {
      ipcRenderer.removeAllListeners('session:loading');
      ipcRenderer.on('session:loading', (_e, d) => cb(d));
    },
    onLoadFailed: (cb: (d: { id: string; errorCode: number; errorDescription: string; url: string }) => void) => {
      ipcRenderer.removeAllListeners('session:loadFailed');
      ipcRenderer.on('session:loadFailed', (_e, d) => cb(d));
    },
    onZoomChanged: (cb: (d: { id: string; zoom: number }) => void) => {
      ipcRenderer.removeAllListeners('session:zoomChanged');
      ipcRenderer.on('session:zoomChanged', (_e, d) => cb(d));
    },
  },

  recording: {
    timeline:  (id: string, opts?: { limit?: number; since?: number }) =>
                 ipcRenderer.invoke('recording:timeline', id, opts),
    exportHAR: (id: string) => ipcRenderer.invoke('recording:exportHAR', id),
  },

  downloads: {
    list:     () => ipcRenderer.invoke('download:list'),
    open:     (id: string) => ipcRenderer.invoke('download:open', id),
    reveal:   (id: string) => ipcRenderer.invoke('download:reveal', id),
    cancel:   (id: string) => ipcRenderer.invoke('download:cancel', id),
    clear:    () => ipcRenderer.invoke('download:clear'),
    onUpdate: (cb: (d: { id: string; filename: string; url: string; state: string; receivedBytes: number; totalBytes: number; savePath: string }) => void) => {
      ipcRenderer.removeAllListeners('download:update');
      ipcRenderer.on('download:update', (_e, d) => cb(d));
    },
    onCleared: (cb: () => void) => {
      ipcRenderer.removeAllListeners('download:cleared');
      ipcRenderer.on('download:cleared', () => cb());
    },
  },

  permission: {
    respond:   (reqId: string, granted: boolean) => ipcRenderer.invoke('permission:respond', reqId, granted),
    onRequest: (cb: (d: { reqId: string; permission: string; origin: string }) => void) => {
      ipcRenderer.removeAllListeners('permission:request');
      ipcRenderer.on('permission:request', (_e, d) => cb(d));
    },
  },

  bookmarks: {
    list:   () => ipcRenderer.invoke('bookmarks:list'),
    add:    (url: string, title: string) => ipcRenderer.invoke('bookmarks:add', url, title),
    remove: (url: string) => ipcRenderer.invoke('bookmarks:remove', url),
  },

  urlHistory: {
    get: ()            => ipcRenderer.invoke('urlHistory:get'),
    add: (url: string) => ipcRenderer.invoke('urlHistory:add', url),
  },

  layout: {
    setConsoleHeight: (h: number)  => ipcRenderer.invoke('layout:setConsoleHeight', h),
    setTopBarHeight:  (h: number)  => ipcRenderer.invoke('layout:setTopBarHeight', h),
    setViewerVisible: (v: boolean) => ipcRenderer.invoke('layout:setViewerVisible', v),
  },

  app: {
    getVersionInfo:     () => ipcRenderer.invoke('app:versionInfo'),
    checkForUpdates:    () => ipcRenderer.invoke('app:checkForUpdates'),
    restartAndInstall:  () => ipcRenderer.invoke('app:restartAndInstall'),
    onUpdateStatus: (cb: (d: { status: string; current: string; latest: string | null }) => void) => {
      ipcRenderer.removeAllListeners('update:status');
      ipcRenderer.on('update:status', (_e, d) => cb(d));
    },
    onShowSettings: (cb: () => void) => {
      ipcRenderer.removeAllListeners('show:settings');
      ipcRenderer.on('show:settings', () => cb());
    },
  },
});
