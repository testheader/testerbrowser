import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('speedDial', {
  getTiles: () => ipcRenderer.invoke('speeddial:get'),
  saveTiles: (tiles: unknown[]) => ipcRenderer.invoke('speeddial:set', tiles),
});
