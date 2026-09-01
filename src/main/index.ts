import { app, BrowserWindow, ipcMain, Menu, clipboard, net } from 'electron';
import path from 'path';
import fs from 'fs';
import { autoUpdater } from 'electron-updater';
import { SessionManager } from './sessionManager';
import { writeUpdateLog, readUpdateLog } from './updateLogger';

let win: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;

type UpdateStatus = 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';
let updateStatus: UpdateStatus = 'checking';
let latestVersion: string | null = null;
let updateLogFile: string;

// --- Generic JSON file store ---

class JsonStore<T> {
  private file: string;
  private data: T;

  constructor(filename: string, defaultValue: T, init?: (raw: unknown) => T) {
    this.file = path.join(app.getPath('userData'), filename);
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      this.data = init ? init(raw) : (raw as T);
    } catch { this.data = defaultValue; }
  }

  get(): T { return this.data; }

  set(value: T): void { this.data = value; this.save(); }

  update(fn: (current: T) => T): T {
    this.data = fn(this.data);
    this.save();
    return this.data;
  }

  private save() { try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch {} }
}

// --- Typed stores ---

interface Bookmark { url: string; title: string; addedAt: number; }
interface SpeedDialTile { id: string; url: string; title: string; }
interface AppSettings { redactSensitiveHeaders: boolean; }

const DEFAULT_SETTINGS: AppSettings = { redactSensitiveHeaders: false };
const DEFAULT_SPEED_DIAL: SpeedDialTile[] = [
  { id: '1', url: 'https://www.google.com',       title: 'Google' },
  { id: '2', url: 'https://github.com',            title: 'GitHub' },
  { id: '3', url: 'https://developer.mozilla.org', title: 'MDN' },
  { id: '4', url: 'https://stackoverflow.com',     title: 'Stack Overflow' },
  { id: '5', url: 'https://caniuse.com',           title: 'Can I Use' },
  { id: '6', url: 'https://regex101.com',          title: 'Regex 101' },
  { id: '7', url: 'https://jsonformatter.org',     title: 'JSON Formatter' },
  { id: '8', url: 'https://httpstatuses.io',       title: 'HTTP Status' },
];

const bookmarkStore   = new JsonStore<Bookmark[]>('bookmarks.json', []);
const urlHistoryStore = new JsonStore<string[]>('url-history.json', []);
const speedDialStore  = new JsonStore<SpeedDialTile[]>('speed-dial.json', DEFAULT_SPEED_DIAL);
const settingsStore   = new JsonStore<AppSettings>('settings.json', DEFAULT_SETTINGS,
  (raw) => ({ ...DEFAULT_SETTINGS, ...(raw as Partial<AppSettings>) }));

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

  // Prevent the privileged renderer from being navigated away from index.html
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  sessionManager = new SessionManager(win, () => settingsStore.get().redactSensitiveHeaders);

  const restored = sessionManager.loadAndRestoreSessions();
  if (!restored) {
    const first = sessionManager.createSession('Default', { persistent: true });
    sessionManager.switchTo(first.id);
  }

  const menu = Menu.buildFromTemplate([
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
  updateLogFile = path.join(app.getPath('userData'), 'update-errors.jsonl');
  createWindow();

  if (app.isPackaged) {
    autoUpdater.allowPrerelease = true;
    autoUpdater.on('checking-for-update', () => { updateStatus = 'checking'; latestVersion = null; pushUpdateStatus(); });
    autoUpdater.on('update-available', (info) => { updateStatus = 'available'; latestVersion = info.version; pushUpdateStatus(); });
    autoUpdater.on('download-progress', () => { updateStatus = 'downloading'; pushUpdateStatus(); });
    autoUpdater.on('update-downloaded', (info) => { updateStatus = 'downloaded'; latestVersion = info.version; pushUpdateStatus(); });
    autoUpdater.on('update-not-available', (info) => { updateStatus = 'not-available'; latestVersion = info.version; pushUpdateStatus(); });
    autoUpdater.on('error', (_e, message) => {
      updateStatus = 'error';
      latestVersion = message ?? null;
      try {
        writeUpdateLog(updateLogFile, {
          timestamp: new Date().toISOString(),
          status: 'error',
          message: String(message ?? 'unknown'),
          currentVersion: app.getVersion(),
          latestVersion,
        });
      } catch {}
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
  // Only restore http/https URLs; empty string falls through to the newtab page
  const startUrl = /^https?:\/\//i.test(opts.url ?? '') ? opts.url : undefined;
  const s = sessionManager?.createSession(opts.name, { partition: opts.partition, startUrl, color: opts.color });
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

ipcMain.handle('recording:timeline',  (_e, id: string, opts) => sessionManager?.getTimeline(id, opts) ?? []);
ipcMain.handle('recording:exportHAR', (_e, id: string) => sessionManager?.getHAR(id) ?? null);
ipcMain.handle('sessions:getCookies',      (_e, id: string) => sessionManager?.getCookies(id) ?? []);
ipcMain.handle('sessions:getLoadedDomains', (_e, id: string) => sessionManager?.getLoadedDomains(id) ?? []);
ipcMain.handle('sessions:getLocalStorage', (_e, id: string) => sessionManager?.getLocalStorage(id) ?? {});
ipcMain.handle('sessions:deleteCookie', (_e, id: string, name: string, domain: string, cookiePath: string, secure: boolean) =>
  sessionManager?.deleteCookie(id, name, domain, cookiePath, secure)
);
ipcMain.handle('sessions:clearCookies', (_e, id: string) => sessionManager?.clearCookies(id));
ipcMain.handle('sessions:setCookie', (_e, id: string, details: Electron.CookiesSetDetails) =>
  sessionManager?.setCookie(id, details)
);
ipcMain.handle('sessions:deleteLocalStorageKey', (_e, id: string, key: string) =>
  sessionManager?.deleteLocalStorageKey(id, key)
);
ipcMain.handle('sessions:setLocalStorageKey', (_e, id: string, key: string, value: string) =>
  sessionManager?.setLocalStorageKey(id, key, value)
);
ipcMain.handle('sessions:clearLocalStorage', (_e, id: string) => sessionManager?.clearLocalStorage(id));
ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(String(text)));

ipcMain.handle('recording:replay', async (_e, req: { method: string; url: string; headers: Record<string, string>; body?: string }) => {
  try {
    const opts: RequestInit = { method: req.method, headers: req.headers };
    if (req.body && !['GET', 'HEAD'].includes(req.method.toUpperCase())) {
      opts.body = req.body;
    }
    const res = await net.fetch(req.url, opts);
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value: string, key: string) => { headers[key] = value; });
    return { ok: true, status: res.status, statusText: res.statusText, headers, body };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

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
ipcMain.handle('bookmarks:list',   () => bookmarkStore.get());
ipcMain.handle('bookmarks:add',    (_e, url: string, title: string) =>
  bookmarkStore.update(bs => [{ url, title, addedAt: Date.now() }, ...bs.filter(b => b.url !== url)])
);
ipcMain.handle('bookmarks:remove', (_e, url: string) =>
  bookmarkStore.update(bs => bs.filter(b => b.url !== url))
);

// URL history IPC
ipcMain.handle('urlHistory:get', () => urlHistoryStore.get());
ipcMain.handle('urlHistory:add', (_e, url: string) => {
  if (!url || url === 'https://example.com') return urlHistoryStore.get();
  return urlHistoryStore.update(h => [url, ...h.filter(u => u !== url)].slice(0, 500));
});

// Speed-dial IPC
ipcMain.handle('speeddial:get', () => speedDialStore.get());
ipcMain.handle('speeddial:set', (e, tiles: unknown) => {
  // Only the newtab page (a file:// URL) may write tiles
  const senderUrl = e.senderFrame?.url ?? '';
  if (!senderUrl.startsWith('file://') || !senderUrl.includes('newtab.html')) return;
  if (!Array.isArray(tiles) || tiles.length > 100) return;
  const sanitized: SpeedDialTile[] = (tiles as unknown[])
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === 'object')
    .map(t => ({
      id:    String(t.id    ?? '').slice(0, 64),
      title: String(t.title ?? '').slice(0, 200),
      // Only allow http/https URLs — drop anything else
      url:   /^https?:\/\//i.test(String(t.url ?? '')) ? String(t.url).slice(0, 2048) : 'about:blank',
    }));
  speedDialStore.set(sanitized);
});

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

// Settings IPC
ipcMain.handle('settings:get', () => settingsStore.get());
ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) =>
  settingsStore.update(s => ({ ...s, ...patch }))
);

// Update log IPC
ipcMain.handle('app:getUpdateLog', () => updateLogFile ? readUpdateLog(updateLogFile) : []);
