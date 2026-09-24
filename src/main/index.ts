import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent, Menu, clipboard, net, safeStorage, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { autoUpdater } from 'electron-updater';
import { SessionManager, TestStep, MockRule, ResilienceRule } from './sessionManager';
import { writeUpdateLog, readUpdateLog } from './updateLogger';
import { upsertById } from './upsert';
import { writeAppErrors, readAppErrors, AppErrorEntry, AppLogLevel } from './errorLog';
import { DebugLogStore } from './debugLogStore';
import { log, initLogger, getRecentErrors } from './appLogger';
import { readLogTail, capLogBlock, capIssueBody } from './logTail';
import { applySettingsPatch, AppSettings } from './settingsPatch';

let win: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;

// --- App-level error log (for bug reports — main process errors, not site console errors) ---

// recordAppError() only appends to appLogger's in-memory ring, which lives in
// this process and is gone the instant it dies. A hard crash (renderer
// killed, OOM, native crash) never drains the event loop far enough for
// before-quit or process.on('exit') to run, so the *next* process's sentinel
// branch (below) is often the only code that ever runs afterward — and it
// starts with a fresh, empty ring of its own. appLogger write-throughs to
// disk on every call (writeAppErrors, from errorLog.ts) so that branch can
// recover what the crashed process actually saw, instead of reading its own
// empty ring.
let appErrorsPath = '';
// Durable, unbounded (up to its own row/age caps) history behind the ring
// above — see debugLogStore.ts. Resolved inside whenReady() alongside the
// other app-lifecycle file paths, so entries recorded before then (there are
// none in practice — nothing calls recordAppError until after whenReady())
// are only captured in the in-memory/write-through ring, not persisted.
let debugLogStore: DebugLogStore | null = null;
// level defaults to 'error' since most call sites (uncaught exceptions,
// unhandled rejections, a crashed/unresponsive renderer, the renderer's own
// app:reportError) are reporting an actual error. #227 triaged the ~28
// previously-silent empty catches this file and sessionManager.ts had —
// most call log.warn/info directly rather than through this wrapper.
// Thin wrapper over appLogger's log[level]() (#225) — source is always
// 'app' here since this call site can't tell which subsystem raised it;
// callers that can (e.g. the updater) call log[level]() directly instead.
function recordAppError(message: string, level: AppLogLevel = 'error') {
  log[level]('app', message);
}
process.on('uncaughtException', (err) => recordAppError(`Uncaught exception: ${err?.stack ?? err?.message ?? String(err)}`));
process.on('unhandledRejection', (reason) => recordAppError(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`));

// --- Privileged-IPC sender check (#217) ---
// src/preload/newtab.ts's contextBridge APIs (speedDial, appTheme, bookmarksApi,
// appSettings, appInfo) ride on NEWTAB_PRELOAD, which every WebContentsView uses —
// including tabs showing a tested website, not only renderer/newtab.html. These
// handlers read/write app-wide state (settings, bookmarks, theme), so only two
// senders may call them: the chrome window itself (win.webContents, used by
// renderer/*.js) and a frame actually showing the new-tab page. Everything else —
// any site under test — is rejected. Mirrors the file:// + newtab.html check
// speeddial:set already had.
function isTrustedIpcSender(e: IpcMainInvokeEvent): boolean {
  if (win && e.sender === win.webContents) return true;
  const senderUrl = e.senderFrame?.url ?? '';
  return senderUrl.startsWith('file://') && senderUrl.includes('newtab.html');
}

// Returns true (and logs once at warn) when the call should be rejected;
// callers do `if (rejectUntrustedSender(e, 'channel:name')) return;`.
function rejectUntrustedSender(e: IpcMainInvokeEvent, channel: string): boolean {
  if (isTrustedIpcSender(e)) return false;
  let origin = 'unknown';
  try { origin = new URL(e.senderFrame?.url ?? '').origin; } catch { /* not a parseable URL (e.g. about:blank) */ }
  recordAppError(`Rejected untrusted IPC call to '${channel}' from ${origin}`, 'warn');
  return true;
}

// --- Crash detection ---
// A sentinel file is written on startup and deleted on clean exit. If it still
// exists at next launch, the previous session ended abnormally (crash).

let normalQuit = false;
let sentinelPath = '';
let crashLogPath = '';
let sessionUrlsPath = '';
// #225's log directory — resolved once in whenReady(), same as the paths
// above, so writeCrashLog()/the applog:* IPC handlers can read/report on
// main.log without each recomputing app.getPath('userData').
let logsDir = '';
// This session's own startedAt, mirroring what gets written into sentinelPath
// below — reused by the process.on('exit') fallback so it and the sentinel
// branch build the crash log the same way instead of diverging.
let sessionStartedAt = '';

// Shared by both paths that can write crash-log.json: the sentinel branch
// (recovers a crashed process's durable state from disk) and the
// process.on('exit') fallback (already has its own live state, since it
// runs inside the still-alive crashing process). Keeping both behind one
// function keeps the written shape identical either way.
function writeCrashLog(startedAt: string, recentErrors: AppErrorEntry[], sessionUrls: string[]) {
  try {
    // #226: the tail is read here — before whenReady()'s sentinel branch
    // returns and #225's initLogger() appends *this* launch's startup
    // header — so it ends with the crashed process's own last lines, not
    // this fresh one's.
    const capped = capLogBlock(readLogTail(logsDir, 200), 30_000);
    const log = {
      timestamp:       startedAt,
      crashedAt:       new Date().toISOString(),
      version:         app.getVersion(),
      electronVersion: process.versions.electron,
      platform:        process.platform,
      recentErrors:    recentErrors.slice(-5),
      sessionUrls,
      logTail:          capped.text ? capped.text.split('\n') : [],
      logTailTruncated: capped.truncated,
    };
    fs.writeFileSync(crashLogPath, JSON.stringify(log));
  } catch (e) {
    // The `log` local above (the crash payload) is scoped to the try block
    // only — this catch block still sees the module-level appLogger `log`.
    log.warn('app', 'Failed to write crash-log.json', { error: String(e) });
  }
}

// Write-through for the live session-URL list, so the sentinel branch on the
// *next* launch can recover what was open in a process that hard-crashed —
// mirrors recordAppError()'s reasoning above. Called by SessionManager
// whenever a session is created/destroyed or navigates (see onSessionsChanged
// passed into its constructor below).
function persistSessionUrls() {
  try {
    if (!sessionUrlsPath) return;
    const urls = (sessionManager?.listSessions() ?? []).map((s: { url?: string }) => s.url ?? '').filter(Boolean);
    fs.writeFileSync(sessionUrlsPath, JSON.stringify(urls));
  // silent: fires on every session create/destroy/navigate — too high-frequency to log; a persistent disk issue also surfaces via saveSessions()'s own warn
  } catch {}
}

type UpdateStatus = 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';
let updateStatus: UpdateStatus = 'checking';
let latestVersion: string | null = null;
let updateLogFile: string;

// Compares two "x.y.z"-style version strings. Returns true if `a` is strictly newer than `b`.
function isVersionNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

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

  private save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch (e) {
      log.warn('app', `Failed to write ${path.basename(this.file)}`, { error: String(e) });
    }
  }
}

// --- Typed stores ---

interface Bookmark { url: string; title: string; addedAt: number; folderId: string | null; }
interface BookmarkFolder { id: string; name: string; createdAt: number; }
interface SpeedDialTile { id: string; url: string; title: string; }
// AppSettings itself lives in settingsPatch.ts (imported above) so the
// whitelist merge there can be unit tested without booting Electron; this
// comment block documents the fields for readers of this file.
// - redactSensitiveHeaders
//   A rule id absent from the map means "enabled" — new rules added later
//   need no migration, they just aren't in anyone's map yet.
// - securityRuleOverrides
// - searchEngine
// - recordPlaybackColumnWidths
//   Record/Playback tab column widths (px) — "Record new test" and "Replay
//   tests"; the run view takes whatever's left. Missing/malformed values
//   (an old settings.json, or a corrupt one) fall back to these defaults
//   rather than a 0-width or negative column.
// - debugMode
//   Shows TesterBrowser's own internal logs (main/IPC/recorder) in the
//   Debug Log console tab — unrelated to the per-session Console tab, which
//   always records the tested page's own console/network regardless of this.

const DEFAULT_SETTINGS: AppSettings = {
  redactSensitiveHeaders: false,
  securityRuleOverrides: {},
  searchEngine: 'google',
  recordPlaybackColumnWidths: { record: 220, saved: 420 },
  debugMode: false,
};
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

const bookmarkStore   = new JsonStore<Bookmark[]>('bookmarks.json', [],
  (raw) => (raw as Partial<Bookmark>[]).map(b => ({ folderId: null, ...b } as Bookmark)));
const bookmarkFoldersStore = new JsonStore<BookmarkFolder[]>('bookmark-folders.json', []);
const urlHistoryStore = new JsonStore<string[]>('url-history.json', []);
const speedDialStore  = new JsonStore<SpeedDialTile[]>('speed-dial.json', DEFAULT_SPEED_DIAL);
// Mirrors the shell's theme choice so newtab views can read it on load.
const themeStore      = new JsonStore<{ scheme: string }>('theme.json', { scheme: 'dark' });
const settingsStore   = new JsonStore<AppSettings>('settings.json', DEFAULT_SETTINGS,
  (raw) => ({ ...DEFAULT_SETTINGS, ...(raw as Partial<AppSettings>) }));

interface JiraSettings { baseUrl: string; email: string; apiToken: string; projectKey: string; }
const DEFAULT_JIRA: JiraSettings = { baseUrl: '', email: '', apiToken: '', projectKey: '' };
const jiraStore = new JsonStore<JiraSettings>('jira-settings.json', DEFAULT_JIRA,
  (raw) => ({ ...DEFAULT_JIRA, ...(raw as Partial<JiraSettings>) }));

interface SavedTest { id: string; name: string; steps: object[]; createdAt: number; updatedAt: number; }
const testsStore = new JsonStore<SavedTest[]>('tests.json', []);

// GitHub token for the in-app bug reporter is encrypted at rest via OS-level
// safeStorage (DPAPI / Keychain / libsecret) — only the ciphertext touches disk.
// refreshTokenEnc is only populated when the GitHub OAuth App has "token
// expiration" enabled, in which case access tokens are short-lived (~8h) and
// must be renewed via the refresh token (itself valid ~6 months) instead of
// forcing the user back through the device-flow sign-in.
interface BugReportSettings { tokenEnc: string | null; refreshTokenEnc: string | null; refreshExpiresAt: number | null; }
const DEFAULT_BUGREPORT: BugReportSettings = { tokenEnc: null, refreshTokenEnc: null, refreshExpiresAt: null };
const bugReportStore = new JsonStore<BugReportSettings>('bugreport-settings.json', DEFAULT_BUGREPORT,
  (raw) => ({ ...DEFAULT_BUGREPORT, ...(raw as Partial<BugReportSettings>) }));

function getGithubToken(): string | null {
  const s = bugReportStore.get();
  if (!s.tokenEnc || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(s.tokenEnc, 'base64')); } catch { return null; }
}

function getGithubRefreshToken(): string | null {
  const s = bugReportStore.get();
  if (!s.refreshTokenEnc || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(s.refreshTokenEnc, 'base64')); } catch { return null; }
}

function clearGithubTokens(): void {
  bugReportStore.set({ tokenEnc: null, refreshTokenEnc: null, refreshExpiresAt: null });
}

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
    frame: false,
    // PNG rather than .ico: reliable cross-platform for the BrowserWindow option
    // (the .ico under build/ is for electron-builder — see package.json build.win.icon).
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));

  win.on('maximize',   () => win?.webContents.send('window:maximizedChanged', true));
  win.on('unmaximize', () => win?.webContents.send('window:maximizedChanged', false));

  win.webContents.on('render-process-gone', (_e, details) => recordAppError(`Chrome UI render process gone: ${details.reason}`));
  win.webContents.on('unresponsive', () => recordAppError('Chrome UI became unresponsive'));

  // Prevent the privileged renderer from being navigated away from index.html
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  sessionManager = new SessionManager(win, () => settingsStore.get().redactSensitiveHeaders, log, persistSessionUrls);

  const restored = sessionManager.loadAndRestoreSessions();
  if (!restored) {
    const first = sessionManager.createSession('Default', { persistent: true });
    sessionManager.switchTo(first.id);
  }

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Import session…', click: () => sessionManager?.importSessionAsNewDialog() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About / Settings', click: () => win?.webContents.send('show:settings') },
        {
          label: 'Report Bug…',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => win?.webContents.send('show:bugreport'),
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  updateLogFile   = path.join(app.getPath('userData'), 'update-errors.jsonl');
  sentinelPath    = path.join(app.getPath('userData'), 'running.sentinel');
  crashLogPath    = path.join(app.getPath('userData'), 'crash-log.json');
  appErrorsPath   = path.join(app.getPath('userData'), 'app-errors.json');
  sessionUrlsPath = path.join(app.getPath('userData'), 'session-urls.json');
  logsDir         = path.join(app.getPath('userData'), 'logs');
  debugLogStore   = new DebugLogStore(path.join(app.getPath('userData'), 'debug-log.sqlite'));

  // If the sentinel is still present, the previous session ended abnormally.
  // Its errors/session URLs only survive if that process wrote them through
  // to disk as they happened (recordAppError()/persistSessionUrls()) — the
  // in-memory ring here belongs to *this* fresh process and is always empty
  // at this point. This must run — and so must writeCrashLog()'s own
  // main.log tail read (#226) — before initLogger() below appends this
  // fresh launch's own startup header, or the crash tail would end with
  // *this* session's header line instead of the crashed one's last lines.
  if (fs.existsSync(sentinelPath)) {
    try {
      const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf-8')) as { startedAt?: string };
      const crashedErrors = readAppErrors(appErrorsPath);
      let crashedSessionUrls: string[] = [];
      // silent: sessionUrlsPath may not exist yet (crash occurred before the first write-through)
      try { crashedSessionUrls = JSON.parse(fs.readFileSync(sessionUrlsPath, 'utf-8')); } catch {}
      writeCrashLog(sentinel.startedAt ?? new Date().toISOString(), crashedErrors, crashedSessionUrls);
    } catch (e) {
      log.warn('app', 'Failed to process crash sentinel', { error: String(e) });
    }
  }
  // Start this session's own durable state clean, so it doesn't inherit
  // whatever the crashed process (or one before it) left behind.
  writeAppErrors(appErrorsPath, []);
  // silent: best-effort reset; a failure here just means the previous crash's already-empty state persists a bit longer
  try { fs.writeFileSync(sessionUrlsPath, JSON.stringify([])); } catch {}
  // Write the sentinel for this session.
  sessionStartedAt = new Date().toISOString();
  // silent: best-effort; a failure here means this session's own crash detection won't fire next launch, no user-visible impact now
  try { fs.writeFileSync(sentinelPath, JSON.stringify({ startedAt: sessionStartedAt })); } catch {}

  initLogger({
    dir: logsDir,
    debugMode: () => settingsStore.get().debugMode,
    debugLogStore,
    appErrorsPath,
  });

  createWindow();
  log.info('app', `App started: ${app.getVersion()} on ${process.platform}`);

  if (app.isPackaged) {
    autoUpdater.allowPrerelease = true;
    // electron-updater's own "update-available" signal isn't trusted blindly — a stale feed
    // or a version tag mishap can fire it for the version already running. Downloading (and
    // therefore reinstalling) only proceeds once we've independently confirmed it's newer.
    autoUpdater.autoDownload = false;
    autoUpdater.on('checking-for-update', () => {
      updateStatus = 'checking'; latestVersion = null; pushUpdateStatus();
      log.info('updater', 'Checking for update');
    });
    autoUpdater.on('update-available', (info) => {
      latestVersion = info.version;
      if (!isVersionNewer(info.version, app.getVersion())) {
        updateStatus = 'not-available';
        pushUpdateStatus();
        log.info('updater', `Update feed reported ${info.version}, not newer than current — ignored`);
        return;
      }
      updateStatus = 'available';
      pushUpdateStatus();
      log.info('updater', `Update available: ${info.version}`);
      autoUpdater.downloadUpdate();
    });
    // download-progress fires repeatedly per download (per chunk) — no
    // breadcrumb here, same high-frequency reasoning as sessionManager.ts's
    // CDP event handlers.
    autoUpdater.on('download-progress', () => { updateStatus = 'downloading'; pushUpdateStatus(); });
    autoUpdater.on('update-downloaded', (info) => {
      updateStatus = 'downloaded'; latestVersion = info.version; pushUpdateStatus();
      log.info('updater', `Update downloaded: ${info.version}`);
    });
    autoUpdater.on('update-not-available', (info) => {
      updateStatus = 'not-available'; latestVersion = info.version; pushUpdateStatus();
      log.info('updater', `No update available (current: ${info.version})`);
    });
    autoUpdater.on('error', async (_e, message) => {
      const fullMsg = String(message ?? 'unknown');
      // When latest.yml is missing from the newest release, try up to 3 previous
      // published releases before surfacing an error to the user.
      if (fullMsg.includes('Cannot find latest.yml')) {
        try {
          const resp = await net.fetch(
            'https://api.github.com/repos/testheader/testerbrowser/releases?per_page=10',
            { headers: { 'User-Agent': 'TesterBrowser-Updater' } }
          );
          if (resp.ok) {
            const releases = await resp.json() as { tag_name: string; draft: boolean; assets: { name: string }[] }[];
            let checked = 0;
            for (const rel of releases) {
              if (rel.draft) continue;
              if (rel.assets.some(a => a.name === 'latest.yml')) {
                const foundVersion = rel.tag_name.replace(/^v/, '');
                latestVersion = foundVersion;
                // A release found while scanning back for a valid latest.yml can be
                // older than what's already installed — that's not an available update.
                updateStatus = isVersionNewer(foundVersion, app.getVersion()) ? 'available' : 'not-available';
                pushUpdateStatus();
                return;
              }
              if (++checked >= 3) break;
            }
          }
        } catch (e) {
          log.warn('updater', 'Failed to scan previous releases for latest.yml', { error: String(e) });
        }
      }
      updateStatus = 'error';
      try {
        writeUpdateLog(updateLogFile, {
          timestamp: new Date().toISOString(),
          status: 'error',
          message: fullMsg,
          currentVersion: app.getVersion(),
          latestVersion: null,
        });
      // silent: writeUpdateLog is the legacy update-errors.jsonl sink — the real failure is captured via log.error('updater', ...) just below
      } catch {}
      log.error('updater', fullMsg);
      // Strip verbose prefix and show only the first line, capped at 120 chars
      latestVersion = fullMsg
        .replace(/^Cannot check for updates:\s*(Error:\s*)?/, '')
        .split('\n')[0]
        .slice(0, 120);
      pushUpdateStatus();
    });
    autoUpdater.checkForUpdates();
  } else {
    updateStatus = 'not-available';
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Temporary tabs are meant to vanish without ceremony (that's the point of the
// feature — see #100) — quit saves persistent sessions and silently discards
// ephemeral ones, same as closing an individual temporary tab already does.
app.on('before-quit', () => {
  normalQuit = true;
  log.info('app', 'App quitting');
  sessionManager?.saveSessions();
  // Clean exit: remove the crash sentinel, any leftover crash log, and this
  // session's durable error/URL state — none of it describes a crash.
  // silent: best-effort cleanup on quit; nothing meaningful to report during shutdown
  try { if (sentinelPath) fs.unlinkSync(sentinelPath); } catch {}
  // silent: best-effort cleanup on quit; nothing meaningful to report during shutdown
  try { if (crashLogPath) fs.unlinkSync(crashLogPath); } catch {}
  // silent: best-effort cleanup on quit; nothing meaningful to report during shutdown
  try { if (appErrorsPath) fs.unlinkSync(appErrorsPath); } catch {}
  // silent: best-effort cleanup on quit; nothing meaningful to report during shutdown
  try { if (sessionUrlsPath) fs.unlinkSync(sessionUrlsPath); } catch {}
  // Unlike the files above, debug-log.sqlite is meant to survive a restart —
  // only close the handle, don't delete it.
  // silent: best-effort cleanup on quit; nothing meaningful to report during shutdown
  try { debugLogStore?.close(); } catch {}
});

// Fallback: if process exits without a clean before-quit (e.g. SIGKILL or a
// native crash that still drains the event loop), write a crash log. Runs
// inside the still-alive crashing process, so appLogger's ring/listSessions()
// are this process's own live state — more current than what it last wrote
// through to appErrorsPath/sessionUrlsPath, though writeCrashLog() below
// builds the same shape the sentinel branch does from that written-through
// state on a harder crash this handler doesn't get to run for at all.
process.on('exit', () => {
  if (normalQuit || !sentinelPath) return;
  try {
    const sessions = sessionManager?.listSessions() ?? [];
    const sessionUrls = sessions.map((s: { url?: string }) => s.url ?? '').filter(Boolean);
    writeCrashLog(sessionStartedAt || new Date().toISOString(), getRecentErrors(), sessionUrls);
    fs.unlinkSync(sentinelPath);
  // silent: process is exiting — no reliable way to observe or act on a failure here
  } catch {}
});

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
ipcMain.handle('sessions:setTabOrder', (_e, order: string[]) => sessionManager?.setTabOrder(order));
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
ipcMain.handle('a11y:getTree',        (_e, id: string) => sessionManager?.getA11yTree(id) ?? null);
ipcMain.handle('a11y:setInspect',     (_e, id: string, enabled: boolean) => sessionManager?.setA11yInspect(id, enabled));
ipcMain.handle('a11y:getViolations',  (_e, id: string) => sessionManager?.getA11yViolations(id) ?? { ok: false, error: 'No session manager' });
ipcMain.handle('a11y:highlightElement', (_e, id: string, selector: string) => sessionManager?.highlightA11yElement(id, selector) ?? false);
ipcMain.handle('a11y:getContrastIssues', (_e, id: string) => sessionManager?.getContrastIssues(id) ?? null);
ipcMain.handle('a11y:highlightNode', (_e, id: string, backendDOMNodeId: number) => sessionManager?.highlightA11yNode(id, backendDOMNodeId) ?? false);
ipcMain.handle('a11y:getAltLabelIssues', (_e, id: string) => sessionManager?.getAltLabelIssues(id) ?? null);
ipcMain.handle('a11y:setFocusOverlay', (_e, id: string, enabled: boolean) => sessionManager?.setA11yFocusOverlay(id, enabled) ?? null);
ipcMain.handle('a11y:detectFocusTrap', (_e, id: string) => sessionManager?.detectA11yFocusTrap(id) ?? null);
ipcMain.handle('session:captureScreenshot', (_e, id: string, opts?: { fullPage?: boolean }) => sessionManager?.captureScreenshot(id, opts) ?? null);
ipcMain.handle('theme:get', (e) => rejectUntrustedSender(e, 'theme:get') ? undefined : themeStore.get().scheme);
ipcMain.handle('theme:set', (e, scheme: string) => {
  if (rejectUntrustedSender(e, 'theme:set')) return;
  const value = scheme === 'light' ? 'light' : 'dark';
  themeStore.set({ scheme: value });
  sessionManager?.broadcastTheme(value);
});
ipcMain.handle('testdata:apply',      (_e, id: string, template: string) => sessionManager?.applyTemplate(id, template));
ipcMain.handle('mock:getRules',    (_e, id: string) => sessionManager?.getMockRules(id) ?? []);
ipcMain.handle('mock:addRule',     (_e, id: string, rule: MockRule) => sessionManager?.addMockRule(id, rule));
ipcMain.handle('mock:removeRule',  (_e, id: string, ruleId: string) => sessionManager?.removeMockRule(id, ruleId));
ipcMain.handle('mock:toggleRule',  (_e, id: string, ruleId: string, enabled: boolean) => sessionManager?.toggleMockRule(id, ruleId, enabled));
ipcMain.handle('mock:updateRule',  (_e, id: string, ruleId: string, patch: Partial<MockRule>) => sessionManager?.updateMockRule(id, ruleId, patch));
ipcMain.handle('resilience:getRules',    (_e, id: string) => sessionManager?.getResilienceRules(id) ?? []);
ipcMain.handle('resilience:addRule',     (_e, id: string, rule: ResilienceRule) => sessionManager?.addResilienceRule(id, rule));
ipcMain.handle('resilience:removeRule',  (_e, id: string, ruleId: string) => sessionManager?.removeResilienceRule(id, ruleId));
ipcMain.handle('resilience:toggleRule',  (_e, id: string, ruleId: string, enabled: boolean) => sessionManager?.toggleResilienceRule(id, ruleId, enabled));
ipcMain.handle('resilience:updateRule',  (_e, id: string, ruleId: string, patch: Partial<ResilienceRule>) => sessionManager?.updateResilienceRule(id, ruleId, patch));
ipcMain.handle('session:setEmulation', (_e, id: string, opts: { timezone?: string; locale?: string; latitude?: number; longitude?: number; accuracy?: number; timeOffsetMs?: number; userAgent?: string; clear?: boolean }) => sessionManager?.setEmulation(id, opts));
ipcMain.handle('session:getEmulation', (_e, id: string) => sessionManager?.getEmulation(id) ?? null);
ipcMain.handle('sessions:getCookies',      (_e, id: string) => sessionManager?.getCookies(id) ?? []);
ipcMain.handle('sessions:getHistory',      (_e, id: string) => sessionManager?.getHistory(id) ?? []);
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

ipcMain.handle('jira:getSettings', () => jiraStore.get());
ipcMain.handle('jira:saveSettings', (_e, s: JiraSettings) => { jiraStore.set({ ...DEFAULT_JIRA, ...s }); });

function jiraAuthHeader(s: JiraSettings): string {
  return 'Basic ' + Buffer.from(`${s.email}:${s.apiToken}`).toString('base64');
}

ipcMain.handle('jira:fetchTicket', async (_e, key: string) => {
  const s = jiraStore.get();
  if (!s.baseUrl || !s.email || !s.apiToken) return { ok: false, error: 'Jira not configured' };
  try {
    const res = await net.fetch(
      `${s.baseUrl.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(key)}`,
      { headers: { 'Authorization': jiraAuthHeader(s), 'Accept': 'application/json' } }
    );
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: (data as { message?: string }).message ?? `HTTP ${res.status}` };
    return { ok: true, data };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('jira:createIssue', async (_e, summary: string, description: string) => {
  const s = jiraStore.get();
  if (!s.baseUrl || !s.email || !s.apiToken || !s.projectKey) return { ok: false, error: 'Jira not configured' };
  try {
    const body = {
      fields: {
        project: { key: s.projectKey },
        summary,
        description: {
          version: 1, type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
        },
        issuetype: { name: 'Bug' },
      },
    };
    const res = await net.fetch(`${s.baseUrl.replace(/\/$/, '')}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        'Authorization': jiraAuthHeader(s),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: (data as { message?: string }).message ?? `HTTP ${res.status}` };
    return { ok: true, key: data.key };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// --- In-app bug reporter ---

const GH_REPO_OWNER = 'testheader';
const GH_REPO_NAME = 'testerbrowser';
const OAUTH_CLIENT_ID = 'Ov23licgMtABkVvMJiem';

let oauthPollAbort: AbortController | null = null;

function saveGithubToken(token: string, refreshToken?: string | null, refreshExpiresIn?: number | null): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const current = bugReportStore.get();
  bugReportStore.set({
    tokenEnc: safeStorage.encryptString(token).toString('base64'),
    refreshTokenEnc: refreshToken
      ? safeStorage.encryptString(refreshToken).toString('base64')
      : current.refreshTokenEnc,
    refreshExpiresAt: refreshExpiresIn ? Date.now() + refreshExpiresIn * 1000 : current.refreshExpiresAt,
  });
  return true;
}

// Renews the access token via the refresh token instead of forcing the user
// back through the device-flow sign-in. Returns the new access token, or
// null if there's no refresh token, it's expired, or GitHub rejects it —
// in which case stored tokens are cleared so the UI falls back to sign-in.
async function refreshGithubToken(): Promise<string | null> {
  const refreshToken = getGithubRefreshToken();
  const { refreshExpiresAt } = bugReportStore.get();
  if (!refreshToken || (refreshExpiresAt && Date.now() >= refreshExpiresAt)) {
    clearGithubTokens();
    return null;
  }
  try {
    const res = await net.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'TesterBrowser-BugReporter' },
      body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    const data = await res.json() as { access_token?: string; refresh_token?: string; refresh_token_expires_in?: number; error?: string };
    if (!data.access_token) {
      clearGithubTokens();
      return null;
    }
    // GitHub rotates the refresh token on every use — persist the new one, falling back to the old.
    saveGithubToken(data.access_token, data.refresh_token ?? refreshToken, data.refresh_token_expires_in ?? null);
    return data.access_token;
  } catch {
    return null;
  }
}

async function pollDeviceFlow(deviceCode: string, intervalSecs: number, expiresAt: number, signal: AbortSignal) {
  let pollInterval = intervalSecs;
  while (Date.now() < expiresAt && !signal.aborted) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollInterval * 1000);
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (signal.aborted) return;
    try {
      const res = await net.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'TesterBrowser-BugReporter' },
        body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      const data = await res.json() as {
        access_token?: string; error?: string; interval?: number;
        refresh_token?: string; refresh_token_expires_in?: number;
      };
      if (data.access_token) {
        saveGithubToken(data.access_token, data.refresh_token ?? null, data.refresh_token_expires_in ?? null);
        win?.webContents.send('bugreport:oauthDone', { ok: true });
        return;
      }
      if (data.error === 'slow_down') pollInterval = (data.interval ?? pollInterval) + 5;
      else if (data.error === 'access_denied' || data.error === 'expired_token') {
        win?.webContents.send('bugreport:oauthDone', { ok: false, error: data.error });
        return;
      }
      // 'authorization_pending' → keep polling
    } catch { /* network hiccup — keep polling */ }
  }
  if (!signal.aborted) win?.webContents.send('bugreport:oauthDone', { ok: false, error: 'expired_token' });
}

ipcMain.handle('bugreport:startOAuth', async () => {
  oauthPollAbort?.abort();
  oauthPollAbort = new AbortController();
  try {
    const res = await net.fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'TesterBrowser-BugReporter' },
      body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, scope: 'public_repo' }),
    });
    if (!res.ok) return { ok: false, error: `GitHub returned HTTP ${res.status}` };
    const data = await res.json() as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number };
    if (!data.device_code || !data.user_code) return { ok: false, error: 'Invalid response from GitHub' };
    shell.openExternal(data.verification_uri ?? 'https://github.com/login/device');
    const expiresAt = Date.now() + (data.expires_in ?? 900) * 1000;
    pollDeviceFlow(data.device_code, data.interval ?? 5, expiresAt, oauthPollAbort.signal)
      .catch((e) => log.warn('bugreport', 'Device flow polling failed unexpectedly', { error: String(e) }));
    return { ok: true, user_code: data.user_code, verification_uri: data.verification_uri, expires_in: data.expires_in };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('bugreport:signOut', () => {
  oauthPollAbort?.abort();
  oauthPollAbort = null;
  clearGithubTokens();
  return { ok: true };
});

ipcMain.handle('bugreport:hasToken', () => !!getGithubToken());

ipcMain.handle('bugreport:checkToken', async () => {
  let token = getGithubToken();
  if (!token) return { valid: false };
  const probe = (t: string) => net.fetch('https://api.github.com/user', {
    headers: { 'Authorization': `Bearer ${t}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'TesterBrowser-BugReporter' },
  });
  try {
    let res = await probe(token);
    if (res.status === 401) {
      token = await refreshGithubToken();
      if (!token) return { valid: false };
      res = await probe(token);
      if (res.status === 401) { clearGithubTokens(); return { valid: false }; }
    }
    return { valid: res.ok };
  } catch { return { valid: false }; }
});

ipcMain.handle('bugreport:saveToken', (_e, token: string) => {
  const trimmed = (token ?? '').trim();
  if (!trimmed) { clearGithubTokens(); return { ok: true }; }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS-level secure storage is unavailable on this system — cannot store the token safely.' };
  }
  // A manually-pasted token replaces any device-flow tokens; it has no refresh token of its own.
  bugReportStore.set({
    tokenEnc: safeStorage.encryptString(trimmed).toString('base64'),
    refreshTokenEnc: null,
    refreshExpiresAt: null,
  });
  return { ok: true };
});

// #226: shared by getDiagnosticsData() (bug-report path, below) and the
// applog:tail IPC handler — the same underlying tail the bug report's
// "App log" block is built from.
function getCappedAppLog(): { text: string; truncated: boolean } {
  return capLogBlock(readLogTail(logsDir, 200), 30_000);
}

function getDiagnosticsData() {
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    recentErrors: getRecentErrors().slice(-10),
    appLog: getCappedAppLog(),
  };
}

ipcMain.handle('bugreport:getDiagnostics', () => getDiagnosticsData());

ipcMain.handle('app:captureScreenshot', () => sessionManager?.captureAppScreenshot() ?? null);

ipcMain.handle('applog:tail', (_e, lines: number) => {
  const n = Math.min(Math.max(1, Math.floor(Number(lines)) || 0), 500);
  return readLogTail(logsDir, n);
});

ipcMain.handle('applog:revealFolder', () => {
  // silent: shell.showItemInFolder() doesn't report failures in a way there's anything useful to log
  try { shell.showItemInFolder(path.join(logsDir, 'main.log')); } catch {}
});

// #226: same <details> wrapper shape as renderer/utils.js's
// formatAppLogBlock() — kept as a separate TS copy since the renderer can't
// import this module, but both wrap the already-capped { text, truncated }
// the main process hands them identically.
function formatAppLogBlockText(appLog: { text: string; truncated: boolean }): string {
  const lineCount = appLog.text ? appLog.text.split('\n').length : 0;
  const summary = `App log (last ${lineCount} lines${appLog.truncated ? ', truncated' : ''})`;
  return `<details><summary>${summary}</summary>\n\n\`\`\`\n${appLog.text}\n\`\`\`\n</details>`;
}

// Default diagnostics text — mirrors renderer/bugreport.js's own preview formatting
// exactly, so what the user sees (and can edit) matches what gets posted verbatim.
function defaultDiagnosticsText(): string {
  const d = getDiagnosticsData();
  const lines = [
    `TesterBrowser: ${d.version}`,
    `Electron: ${d.electron}  Chrome: ${d.chrome}  Node: ${d.node}`,
    `${d.platform} ${d.arch} (${d.osRelease})`,
    '',
    d.recentErrors.length
      ? `Recent app errors:\n${d.recentErrors.map(e => `[${new Date(e.ts).toLocaleTimeString()}] ${e.message}`).join('\n')}`
      : 'No recent app errors recorded.',
    '',
    formatAppLogBlockText(d.appLog),
  ];
  return lines.join('\n');
}

function wrapDiagnosticsMarkdown(area: string, text: string): string {
  return [
    '<details><summary>Diagnostics</summary>', '',
    '```', `Feature area: ${area}`, '', text, '```',
    '</details>',
  ].join('\n');
}

// Best-effort: finds a GitHub Projects (v2) board titled "Testerbrowser" owned by
// the repo owner and adds the issue to it. Silently returns false on any failure
// (missing scope, no such board, etc.) — the issue itself is still created either way.
async function addIssueToProjectBoard(token: string, issueNodeId: string): Promise<boolean> {
  try {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'TesterBrowser-BugReporter',
    };
    const ownerQuery = `query($owner: String!) {
      repositoryOwner(login: $owner) {
        ... on ProjectV2Owner { projectsV2(first: 20) { nodes { id title } } }
      }
    }`;
    const res1 = await net.fetch('https://api.github.com/graphql', {
      method: 'POST', headers,
      body: JSON.stringify({ query: ownerQuery, variables: { owner: GH_REPO_OWNER } }),
    });
    const json1 = await res1.json() as { data?: { repositoryOwner?: { projectsV2?: { nodes?: { id: string; title: string }[] } } } };
    const nodes = json1.data?.repositoryOwner?.projectsV2?.nodes ?? [];
    const project = nodes.find(p => p.title.toLowerCase().includes('testerbrowser'));
    if (!project) return false;

    const mutation = `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } }
    }`;
    const res2 = await net.fetch('https://api.github.com/graphql', {
      method: 'POST', headers,
      body: JSON.stringify({ query: mutation, variables: { projectId: project.id, contentId: issueNodeId } }),
    });
    const json2 = await res2.json() as { data?: { addProjectV2ItemById?: { item?: { id: string } } } };
    return !!json2.data?.addProjectV2ItemById?.item?.id;
  } catch { return false; }
}

ipcMain.handle('bugreport:submit', async (_e, payload: { area: string; description: string; diagnostics?: string; screenshotB64?: string | null }) => {
  let token = getGithubToken();
  if (!token) return { ok: false, error: 'No GitHub token configured. Add one in Settings.' };
  if (!payload?.description?.trim()) return { ok: false, error: 'Description is required.' };

  const title = `[${payload.area}] ${payload.description.trim().split('\n')[0].slice(0, 80)}`;
  const diagnosticsText = payload.diagnostics?.trim() || defaultDiagnosticsText();
  // #226: caps the final body at 60,000 chars, truncating diagnostics (which
  // carries the app-log block at its own tail) rather than the user's
  // description — never the other way around.
  const body = capIssueBody(payload.description.trim(), wrapDiagnosticsMarkdown(payload.area, diagnosticsText), 60_000);

  try {
    const createIssue = (t: string) => net.fetch(`https://api.github.com/repos/${GH_REPO_OWNER}/${GH_REPO_NAME}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${t}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'TesterBrowser-BugReporter',
      },
      body: JSON.stringify({ title, body, labels: ['status-ready'] }),
    });
    let res = await createIssue(token);
    if (res.status === 401) {
      const refreshed = await refreshGithubToken();
      if (!refreshed) return { ok: false, error: 'GitHub token is invalid or expired. Please sign in again in Settings.' };
      token = refreshed;
      res = await createIssue(token);
    }
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      if (res.status === 401) {
        clearGithubTokens();
        return { ok: false, error: 'GitHub token is invalid or expired. Please sign in again in Settings.' };
      }
      return { ok: false, error: (data as { message?: string }).message ?? `HTTP ${res.status}` };
    }

    let screenshotAttached = false;
    let screenshotError: string | null = null;
    if (payload.screenshotB64) {
      try {
        const filePath = `.github/bug-report-screenshots/issue-${data.number}.jpg`;
        const putRes = await net.fetch(`https://api.github.com/repos/${GH_REPO_OWNER}/${GH_REPO_NAME}/contents/${filePath}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'TesterBrowser-BugReporter',
          },
          body: JSON.stringify({ message: `Bug report screenshot for #${data.number}`, content: payload.screenshotB64 }),
        });
        if (!putRes.ok) {
          const putData = await putRes.json().catch(() => ({})) as { message?: string };
          screenshotError = putData.message ?? `Upload failed: HTTP ${putRes.status}`;
        } else {
          const screenshotUrl = `https://raw.githubusercontent.com/${GH_REPO_OWNER}/${GH_REPO_NAME}/main/${filePath}`;
          const patchRes = await net.fetch(`https://api.github.com/repos/${GH_REPO_OWNER}/${GH_REPO_NAME}/issues/${data.number}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json',
              'Content-Type': 'application/json',
              'User-Agent': 'TesterBrowser-BugReporter',
            },
            body: JSON.stringify({ body: `${body}\n\n![TesterBrowser screenshot](${screenshotUrl})` }),
          });
          if (patchRes.ok) {
            screenshotAttached = true;
          } else {
            const patchData = await patchRes.json().catch(() => ({})) as { message?: string };
            screenshotError = patchData.message ?? `Embedding failed: HTTP ${patchRes.status}`;
          }
        }
      } catch (e: unknown) {
        screenshotError = e instanceof Error ? e.message : String(e);
      }
    }

    const boardAdded = await addIssueToProjectBoard(token, data.node_id as string);
    log.info('bugreport', `Bug report submitted: issue #${data.number}`);
    return { ok: true, url: data.html_url, number: data.number, boardAdded, screenshotAttached, screenshotError };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log.error('bugreport', `Bug report submission failed: ${message}`);
    return { ok: false, error: message };
  }
});

// --- Crash log IPC ---

ipcMain.handle('crash:check', () => {
  if (!crashLogPath) return null;
  try { return JSON.parse(fs.readFileSync(crashLogPath, 'utf-8')); } catch { return null; }
});

ipcMain.handle('crash:clear', () => {
  // silent: best-effort cleanup; ENOENT here is the common/expected case (already cleared)
  try { if (crashLogPath) fs.unlinkSync(crashLogPath); } catch {}
  return { ok: true };
});

ipcMain.handle('recording:replay', async (_e, req: { method: string; url: string; headers: Record<string, string>; body?: string }) => {
  try {
    const opts: RequestInit = { method: req.method, headers: req.headers };
    if (req.body && !['GET', 'HEAD'].includes(req.method.toUpperCase())) {
      opts.body = req.body;
    }
    const res = await net.fetch(req.url, opts);
    const headers: Record<string, string> = {};
    res.headers.forEach((value: string, key: string) => { headers[key] = value; });
    const isImage = (headers['content-type'] || '').toLowerCase().startsWith('image/');
    if (isImage) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: true, status: res.status, statusText: res.statusText, headers, bodyBase64: buf.toString('base64') };
    }
    const body = await res.text();
    return { ok: true, status: res.status, statusText: res.statusText, headers, body };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('layout:setConsoleHeight',(_e, h: number) => sessionManager?.setConsoleHeight(h));
ipcMain.handle('layout:setTopBarHeight', (_e, h: number) => sessionManager?.setTopBarHeight(h));
ipcMain.handle('layout:setViewerVisible',(_e, v: boolean) => sessionManager?.setViewerVisible(v));
ipcMain.handle('layout:setRightPanelWidth', (_e, w: number) => sessionManager?.setRightPanelWidth(w));
ipcMain.handle('layout:beginPageOverlay', () => sessionManager?.beginPageOverlay() ?? null);
ipcMain.handle('layout:endPageOverlay', () => sessionManager?.endPageOverlay());

// Window control IPC
ipcMain.handle('window:minimize',    () => win?.minimize());
ipcMain.handle('window:maximize',    () => { if (win?.isMaximized()) win.unmaximize(); else win?.maximize(); });
ipcMain.handle('window:close',       () => win?.close());
ipcMain.handle('window:isMaximized', () => win?.isMaximized() ?? false);

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
ipcMain.handle('bookmarks:list',   (e) => rejectUntrustedSender(e, 'bookmarks:list') ? [] : bookmarkStore.get());
ipcMain.handle('bookmarks:add',    (e, url: string, title: string) => {
  if (rejectUntrustedSender(e, 'bookmarks:add')) return;
  return bookmarkStore.update(bs => [{ url, title, addedAt: Date.now(), folderId: null }, ...bs.filter(b => b.url !== url)]);
});
ipcMain.handle('bookmarks:remove', (e, url: string) => {
  if (rejectUntrustedSender(e, 'bookmarks:remove')) return;
  return bookmarkStore.update(bs => bs.filter(b => b.url !== url));
});
ipcMain.handle('bookmarks:rename', (e, url: string, title: string) => {
  if (rejectUntrustedSender(e, 'bookmarks:rename')) return;
  return bookmarkStore.update(bs => bs.map(b => (b.url === url ? { ...b, title } : b)));
});
ipcMain.handle('bookmarks:move', (e, url: string, folderId: string | null) => {
  if (rejectUntrustedSender(e, 'bookmarks:move')) return;
  return bookmarkStore.update(bs => bs.map(b => (b.url === url ? { ...b, folderId } : b)));
});

ipcMain.handle('bookmarks:listFolders', (e) => rejectUntrustedSender(e, 'bookmarks:listFolders') ? [] : bookmarkFoldersStore.get());
ipcMain.handle('bookmarks:createFolder', (e, name: string) => {
  if (rejectUntrustedSender(e, 'bookmarks:createFolder')) return;
  return bookmarkFoldersStore.update(fs => [
    ...fs,
    { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name, createdAt: Date.now() },
  ]);
});
ipcMain.handle('bookmarks:renameFolder', (e, id: string, name: string) => {
  if (rejectUntrustedSender(e, 'bookmarks:renameFolder')) return;
  return bookmarkFoldersStore.update(fs => fs.map(f => (f.id === id ? { ...f, name } : f)));
});
ipcMain.handle('bookmarks:removeFolder', (e, id: string) => {
  if (rejectUntrustedSender(e, 'bookmarks:removeFolder')) return;
  // Bookmarks inside the deleted folder move back to the top level rather than being lost.
  bookmarkStore.update(bs => bs.map(b => (b.folderId === id ? { ...b, folderId: null } : b)));
  return bookmarkFoldersStore.update(fs => fs.filter(f => f.id !== id));
});

// URL history IPC
ipcMain.handle('urlHistory:get', () => urlHistoryStore.get());
ipcMain.handle('urlHistory:add', (_e, url: string) => {
  if (!url || url === 'https://example.com') return urlHistoryStore.get();
  return urlHistoryStore.update(h => [url, ...h.filter(u => u !== url)].slice(0, 500));
});

// Speed-dial IPC
ipcMain.handle('speeddial:get', (e) => rejectUntrustedSender(e, 'speeddial:get') ? [] : speedDialStore.get());
ipcMain.handle('speeddial:set', (e, tiles: unknown) => {
  if (rejectUntrustedSender(e, 'speeddial:set')) return;
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
ipcMain.handle('app:versionInfo', (e) => rejectUntrustedSender(e, 'app:versionInfo') ? null : ({
  current: app.getVersion(), latest: latestVersion, status: updateStatus, isPackaged: app.isPackaged,
}));
ipcMain.handle('app:checkForUpdates', () => {
  if (!app.isPackaged) return;
  updateStatus = 'checking'; latestVersion = null;
  pushUpdateStatus();
  autoUpdater.checkForUpdates();
});
ipcMain.handle('app:restartAndInstall', () => autoUpdater.quitAndInstall());
ipcMain.handle('app:openExternal', (_e, url: string) => {
  if (/^https:\/\//i.test(url ?? '')) shell.openExternal(url);
});
ipcMain.handle('app:reportError', (_e, message: string) => recordAppError(String(message)));
ipcMain.handle('app:debugLog', () => debugLogStore?.getEntries({ limit: 500 }) ?? getRecentErrors());

// Tests (record-playback) IPC
ipcMain.handle('tests:list', () => testsStore.get());
ipcMain.handle('tests:save', (_e, test: SavedTest) => {
  testsStore.update(all => upsertById(all, test));
});
ipcMain.handle('tests:load', (_e, id: string) => testsStore.get().find(t => t.id === id) ?? null);
ipcMain.handle('tests:delete', (_e, id: string) => testsStore.update(all => all.filter(t => t.id !== id)));
ipcMain.handle('session:startRecording',     (_e, id: string) => sessionManager?.startRecording(id) ?? null);
ipcMain.handle('session:stopRecording',      (_e, id: string) => sessionManager?.stopRecording(id) ?? []);
ipcMain.handle('session:pollRecordingSteps', (_e, id: string) => sessionManager?.pollRecordingSteps(id) ?? []);
ipcMain.handle('session:playbackStep',       (_e, id: string, step: TestStep) => sessionManager?.playbackStep(id, step) ?? null);
ipcMain.handle('session:countSelectorMatches', (_e, id: string, selector: string) => sessionManager?.countSelectorMatches(id, selector) ?? -1);

ipcMain.handle('followalong:start', (_e, leaderId: string, followerId: string, mirrorNavigation: boolean) =>
  sessionManager?.startFollowAlong(leaderId, followerId, mirrorNavigation) ?? { ok: false, error: 'No session manager' });
ipcMain.handle('followalong:stop', (_e, leaderId: string) => sessionManager?.stopFollowAlong(leaderId) ?? false);
ipcMain.handle('followalong:setMirrorNavigation', (_e, leaderId: string, mirrorNavigation: boolean) =>
  sessionManager?.setFollowMirrorNavigation(leaderId, mirrorNavigation) ?? false);
ipcMain.handle('followalong:list', () => sessionManager?.listFollowPairings() ?? []);

// Settings IPC
ipcMain.handle('settings:get', (e) => rejectUntrustedSender(e, 'settings:get') ? null : settingsStore.get());
ipcMain.handle('settings:set', (e, patch: unknown) => {
  if (rejectUntrustedSender(e, 'settings:set')) return;
  return settingsStore.update(s => applySettingsPatch(s, patch));
});

// Update log IPC
ipcMain.handle('app:getUpdateLog', () => updateLogFile ? readUpdateLog(updateLogFile) : []);
