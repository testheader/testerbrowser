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
  },
  recording: {
    timeline: (id: string, opts?: { limit?: number; since?: number }) =>
      ipcRenderer.invoke('recording:timeline', id, opts),
    exportHAR: (id: string) => ipcRenderer.invoke('recording:exportHAR', id),
  },
});
