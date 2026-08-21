import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { autoUpdater } from 'electron-updater';
import { SessionManager } from './sessionManager';

let win: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;

type UpdateStatus = 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';
let updateStatus: UpdateStatus = 'checking';
let latestVersion: string | null = null;

// --- Bookmark manager ---

interface Bookmark { url: string; title: string; addedAt: number; }

class BookmarkManager {
  private file: string;
  private bookmarks: Bookmark[] = [];

  constructor() {
    this.file = path.join(app.getPath('userData'), 'bookmarks.json');
    try { this.bookmarks = JSON.parse(fs.readFileSync(this.file, 'utf-8')); } catch {}
  }

  list() { return this.bookmarks; }

  add(url: string, title: string) {
    this.bookmarks = this.bookmarks.filter(b => b.url !== url);
    this.bookmarks.unshift({ url, title, addedAt: Date.now() });
    this.save();
    return this.bookmarks;
  }

  remove(url: string) {
    this.bookmarks = this.bookmarks.filter(b => b.url !== url);
    this.save();
    return this.bookmarks;
  }

  private save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.bookmarks)); } catch {}
  }
}

const bookmarkManager = new BookmarkManager();

// ---

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

  const restored = sessionManager.loadAndRestoreSessions();
  if (!restored) {
    const first = sessionManager.createSession('Default', { persistent: true });
    sessionManager.switchTo(first.id);
  }

  const menu = Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About / Settings', click: () => win?.webContents.send('show:settings') },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  createWindow();

  if (app.isPackaged) {
    autoUpdater.allowPrerelease = true;
    autoUpdater.on('checking-for-update', () => { updateStatus = 'checking'; latestVersion = null; pushUpdateStatus(); });
    autoUpdater.on('update-available', (info) => { updateStatus = 'available'; latestVersion = info.version; pushUpdateStatus(); });
    autoUpdater.on('download-progress', () => { updateStatus = 'downloading'; pushUpdateStatus(); });
    autoUpdater.on('update-downloaded', (info) => { updateStatus = 'downloaded'; latestVersion = info.version; pushUpdateStatus(); });
    autoUpdater.on('update-not-available', (info) => { updateStatus = 'not-available'; latestVersion = info.version; pushUpdateStatus(); });
    autoUpdater.on('error', (_e, message) => { updateStatus = 'error'; latestVersion = message ?? null; pushUpdateStatus(); });
    autoUpdater.checkForUpdatesAndNotify();
  } else {
    updateStatus = 'not-available';
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => sessionManager?.saveSessions());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC surface ---

ipcMain.handle('sessions:list',    () => sessionManager?.listSessions() ?? []);
ipcMain.handle('sessions:create',  (_e, name: string, opts) => sessionManager?.createSession(name, opts).id);
ipcMain.handle('sessions:switch',  (_e, id: string) => sessionManager?.switchTo(id));
ipcMain.handle('sessions:destroy', (_e, id: string) => sessionManager?.destroySession(id));
ipcMain.handle('sessions:navigate',(_e, id: string, url: string) => sessionManager?.navigate(id, url));
ipcMain.handle('sessions:rename',  (_e, id: string, name: string) => sessionManager?.renameSession(id, name));
ipcMain.handle('sessions:pin',     (_e, id: string, pinned: boolean) => sessionManager?.pinSession(id, pinned));
ipcMain.handle('sessions:reopen',  (_e, opts: { name: string; url: string; partition: string; color?: string }) => {
  const s = sessionManager?.createSession(opts.name, { partition: opts.partition, startUrl: opts.url, color: opts.color });
  return s?.id ?? null;
});

ipcMain.handle('sessions:clone', async (_e, sourceId: string, newName: string) => {
  const s = await sessionManager?.cloneSession(sourceId, newName);
  return s?.id ?? null;
});

ipcMain.handle('sessions:back',     (_e, id: string) => sessionManager?.back(id));
ipcMain.handle('sessions:forward',  (_e, id: string) => sessionManager?.forward(id));
ipcMain.handle('sessions:reload',   (_e, id: string) => sessionManager?.reload(id));
ipcMain.handle('sessions:stop',     (_e, id: string) => sessionManager?.stop(id));
ipcMain.handle('sessions:setZoom',  (_e, id: string, delta: number) => sessionManager?.setZoom(id, delta));
ipcMain.handle('sessions:resetZoom',(_e, id: string) => sessionManager?.resetZoom(id));
ipcMain.handle('sessions:getZoom',  (_e, id: string) => sessionManager?.getZoom(id) ?? 1);
ipcMain.handle('devtools:toggle',   (_e, id: string) => sessionManager?.toggleDevTools(id));

ipcMain.handle('find:start', (_e, id: string, text: string, forward: boolean, findNext: boolean) =>
  sessionManager?.findInPage(id, text, forward, findNext)
);
ipcMain.handle('find:stop', (_e, id: string) => sessionManager?.stopFind(id));

ipcMain.handle('sessions:notes:get', (_e, id: string) => sessionManager?.getNotes(id) ?? '');
ipcMain.handle('sessions:notes:set', (_e, id: string, notes: string) => sessionManager?.setNotes(id, notes));
ipcMain.handle('sessions:contextMenu', (_e, id: string) => sessionManager?.showContextMenu(id));

ipcMain.handle('recording:timeline', (_e, id: string, opts) => sessionManager?.getTimeline(id, opts) ?? []);

ipcMain.handle('layout:setConsoleHeight',(_e, h: number) => sessionManager?.setConsoleHeight(h));
ipcMain.handle('layout:setTopBarHeight', (_e, h: number) => sessionManager?.setTopBarHeight(h));
ipcMain.handle('layout:setViewerVisible',(_e, v: boolean) => sessionManager?.setViewerVisible(v));

// Download IPC
ipcMain.handle('download:list',   () => sessionManager?.listDownloads() ?? []);
ipcMain.handle('download:open',   (_e, id: string) => sessionManager?.openDownload(id));
ipcMain.handle('download:reveal', (_e, id: string) => sessionManager?.revealDownload(id));
ipcMain.handle('download:cancel', (_e, id: string) => sessionManager?.cancelDownload(id));
ipcMain.handle('download:clear',  () => sessionManager?.clearDownloads());

// Permission IPC
ipcMain.handle('permission:respond', (_e, reqId: string, granted: boolean) =>
  sessionManager?.respondPermission(reqId, granted)
);

// Bookmark IPC
ipcMain.handle('bookmarks:list',   () => bookmarkManager.list());
ipcMain.handle('bookmarks:add',    (_e, url: string, title: string) => bookmarkManager.add(url, title));
ipcMain.handle('bookmarks:remove', (_e, url: string) => bookmarkManager.remove(url));

// App IPC
ipcMain.handle('app:versionInfo', () => ({
  current: app.getVersion(), latest: latestVersion, status: updateStatus, isPackaged: app.isPackaged,
}));
ipcMain.handle('app:checkForUpdates', () => {
  if (!app.isPackaged) return;
  updateStatus = 'checking'; latestVersion = null;
  pushUpdateStatus();
  autoUpdater.checkForUpdatesAndNotify();
});
ipcMain.handle('app:restartAndInstall', () => autoUpdater.quitAndInstall());
