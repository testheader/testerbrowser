import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('speedDial', {
  getTiles: () => ipcRenderer.invoke('speeddial:get'),
  saveTiles: (tiles: unknown[]) => ipcRenderer.invoke('speeddial:set', tiles),
});

contextBridge.exposeInMainWorld('appTheme', {
  get: () => ipcRenderer.invoke('theme:get'),
  onChange: (cb: (scheme: string) => void) => {
    ipcRenderer.on('theme:changed', (_e, scheme: string) => cb(scheme));
  },
});
