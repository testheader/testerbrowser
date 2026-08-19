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
    setZoom:     (id: string, delta: number) => ipcRenderer.invoke('sessions:setZoom', id, delta),
    resetZoom:   (id: string) => ipcRenderer.invoke('sessions:resetZoom', id),
    devtools:    (id: string) => ipcRenderer.invoke('devtools:toggle', id),
    contextMenu: (id: string) => ipcRenderer.invoke('sessions:contextMenu', id),
    findInPage:  (id: string, text: string, forward: boolean, findNext: boolean) =>
                   ipcRenderer.invoke('find:start', id, text, forward, findNext),
    stopFind:    (id: string) => ipcRenderer.invoke('find:stop', id),
    getNotes:    (id: string) => ipcRenderer.invoke('sessions:notes:get', id),
    setNotes:    (id: string, notes: string) => ipcRenderer.invoke('sessions:notes:set', id, notes),

    onNavigated:     (cb: (d: { id: string; url: string }) => void) =>
                       ipcRenderer.on('session:navigated', (_e, d) => cb(d)),
    onNavState:      (cb: (d: { id: string; canBack: boolean; canForward: boolean }) => void) =>
                       ipcRenderer.on('session:navState', (_e, d) => cb(d)),
    onTitleUpdated:  (cb: (d: { id: string; title: string }) => void) =>
                       ipcRenderer.on('session:titleUpdated', (_e, d) => cb(d)),
    onFaviconUpdated:(cb: (d: { id: string; favicon: string }) => void) =>
                       ipcRenderer.on('session:faviconUpdated', (_e, d) => cb(d)),
    onTabCycle:      (cb: (d: { reverse: boolean }) => void) =>
                       ipcRenderer.on('tabs:cycle', (_e, d) => cb(d)),
    onNewTab:        (cb: (d: { id: string }) => void) =>
                       ipcRenderer.on('session:newTab', (_e, d) => cb(d)),
    onTabAction:     (cb: (d: { action: string; id: string }) => void) =>
                       ipcRenderer.on('tab:action', (_e, d) => cb(d)),
    onFindResult:    (cb: (d: { id: string; matches: number; activeMatch: number }) => void) =>
                       ipcRenderer.on('find:result', (_e, d) => cb(d)),
    onShortcut:      (cb: (key: string) => void) =>
                       ipcRenderer.on('app:shortcut', (_e, key) => cb(key)),
  },
  recording: {
    timeline: (id: string, opts?: { limit?: number; since?: number }) =>
                ipcRenderer.invoke('recording:timeline', id, opts),
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
    onUpdateStatus: (cb: (d: { status: string; current: string; latest: string | null }) => void) =>
                      ipcRenderer.on('update:status', (_e, d) => cb(d)),
    onShowSettings: (cb: () => void) =>
                      ipcRenderer.on('show:settings', () => cb()),
  },
});
