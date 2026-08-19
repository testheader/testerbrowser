import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { SessionManager } from './sessionManager';

let win: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));

  sessionManager = new SessionManager(win);

  // Create a default session on launch so recording starts immediately.
  const first = sessionManager.createSession('Default', { persistent: true });
  sessionManager.switchTo(first.id);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC surface for the renderer UI ---

ipcMain.handle('sessions:list', () => sessionManager?.listSessions() ?? []);

ipcMain.handle('sessions:create', (_e, name: string, opts) =>
  sessionManager?.createSession(name, opts).id
);

ipcMain.handle('sessions:switch', (_e, id: string) => sessionManager?.switchTo(id));

ipcMain.handle('sessions:clone', async (_e, sourceId: string, newName: string) => {
  const s = await sessionManager?.cloneSession(sourceId, newName);
  return s?.id ?? null;
});

ipcMain.handle('sessions:destroy', (_e, id: string) => sessionManager?.destroySession(id));

ipcMain.handle('sessions:navigate', (_e, id: string, url: string) =>
  sessionManager?.navigate(id, url)
);

ipcMain.handle('recording:timeline', (_e, id: string, opts) =>
  sessionManager?.getTimeline(id, opts) ?? []
);

ipcMain.handle('recording:exportHAR', (_e, id: string) => sessionManager?.exportHAR(id) ?? null);
