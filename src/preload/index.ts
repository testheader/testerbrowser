import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('testerBrowser', {
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (name: string, opts?: { persistent?: boolean; startUrl?: string }) =>
      ipcRenderer.invoke('sessions:create', name, opts),
    switchTo: (id: string) => ipcRenderer.invoke('sessions:switch', id),
    navigate: (id: string, url: string) => ipcRenderer.invoke('sessions:navigate', id, url),
    clone: (sourceId: string, newName: string) =>
      ipcRenderer.invoke('sessions:clone', sourceId, newName),
    destroy: (id: string) => ipcRenderer.invoke('sessions:destroy', id),
    onNavigated: (cb: (data: { id: string; url: string }) => void) =>
      ipcRenderer.on('session:navigated', (_e, data) => cb(data)),
    onTabCycle: (cb: (data: { reverse: boolean }) => void) =>
      ipcRenderer.on('tabs:cycle', (_e, data) => cb(data)),
  },
  recording: {
    timeline: (id: string, opts?: { limit?: number; since?: number }) =>
      ipcRenderer.invoke('recording:timeline', id, opts),
    exportHAR: (id: string) => ipcRenderer.invoke('recording:exportHAR', id),
  },
  app: {
    getVersionInfo: () => ipcRenderer.invoke('app:versionInfo'),
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    restartAndInstall: () => ipcRenderer.invoke('app:restartAndInstall'),
    onUpdateStatus: (cb: (data: { status: string; current: string; latest: string | null }) => void) =>
      ipcRenderer.on('update:status', (_e, data) => cb(data)),
    onShowSettings: (cb: () => void) =>
      ipcRenderer.on('show:settings', () => cb()),
  },
});
