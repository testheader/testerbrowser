import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'path';
import { autoUpdater } from 'electron-updater';
import { SessionManager } from './sessionManager';

let win: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;

type UpdateStatus = 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';
let updateStatus: UpdateStatus = 'checking';
let latestVersion: string | null = null;

function pushUpdateStatus() {
  win?.webContents.send('update:status', {
    status: updateStatus,
    current: app.getVersion(),
    latest: latestVersion,
  });
}

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

  const first = sessionManager.createSession('Default', { persistent: true });
  sessionManager.switchTo(first.id);

  const menu = Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About / Settings',
          click: () => win?.webContents.send('show:settings'),
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  createWindow();

  if (app.isPackaged) {
    autoUpdater.allowPrerelease = true;
    autoUpdater.on('checking-for-update', () => {
      updateStatus = 'checking';
      latestVersion = null;
      pushUpdateStatus();
    });
    autoUpdater.on('update-available', (info) => {
      updateStatus = 'available';
      latestVersion = info.version;
      pushUpdateStatus();
    });
    autoUpdater.on('download-progress', () => {
      updateStatus = 'downloading';
      pushUpdateStatus();
    });
    autoUpdater.on('update-downloaded', (info) => {
      updateStatus = 'downloaded';
      latestVersion = info.version;
      pushUpdateStatus();
    });
    autoUpdater.on('update-not-available', (info) => {
      updateStatus = 'not-available';
      latestVersion = info.version;
      pushUpdateStatus();
    });
    autoUpdater.on('error', (_e, message) => {
      updateStatus = 'error';
      latestVersion = message ?? null;
      pushUpdateStatus();
    });

    autoUpdater.checkForUpdatesAndNotify();
  } else {
    updateStatus = 'not-available';
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC surface ---

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

ipcMain.handle('sessions:rename', (_e, id: string, name: string) =>
  sessionManager?.renameSession(id, name)
);

ipcMain.handle('recording:timeline', (_e, id: string, opts) =>
  sessionManager?.getTimeline(id, opts) ?? []
);

ipcMain.handle('recording:exportHAR', (_e, id: string) => sessionManager?.exportHAR(id) ?? null);

ipcMain.handle('layout:setConsoleHeight', (_e, height: number) =>
  sessionManager?.setConsoleHeight(height)
);

ipcMain.handle('layout:setViewerVisible', (_e, visible: boolean) =>
  sessionManager?.setViewerVisible(visible)
);

ipcMain.handle('app:versionInfo', () => ({
  current: app.getVersion(),
  latest: latestVersion,
  status: updateStatus,
  isPackaged: app.isPackaged,
}));

ipcMain.handle('app:checkForUpdates', () => {
  if (!app.isPackaged) return;
  updateStatus = 'checking';
  latestVersion = null;
  pushUpdateStatus();
  autoUpdater.checkForUpdatesAndNotify();
});

ipcMain.handle('app:restartAndInstall', () => {
  autoUpdater.quitAndInstall();
});
