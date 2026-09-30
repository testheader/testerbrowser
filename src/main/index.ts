import { app, BrowserWindow, IpcMainInvokeEvent, Menu, net, safeStorage, powerMonitor } from 'electron';
import path from 'path';
import fs from 'fs';
import { autoUpdater } from 'electron-updater';
import { SessionManager, getHostname } from './sessionManager';
import { VisualRegressionStore } from './visualRegressionStore';
import { firstHttpUrl } from './singleInstance';
import { isTrustedNewtabFrame } from './newtabUrl';
import { canAutoInstall, IDLE_INSTALL_MINUTES } from './idleInstall';
import { writeAppErrors, readAppErrors, AppErrorEntry, AppLogLevel } from './errorLog';
import { DebugLogStore } from './debugLogStore';
import { log, initLogger, getRecentErrors } from './appLogger';
import { readLogTail, capLogBlock } from './logTail';
import {
  AppSettings, clampNumberSetting,
  RECORDER_MAX_EVENTS_MIN, RECORDER_MAX_EVENTS_MAX,
  RECORDING_RETENTION_DAYS_MIN, RECORDING_RETENTION_DAYS_MAX,
} from './settingsPatch';
import { migrateJiraSettings, DEFAULT_JIRA_SETTINGS, JiraSettingsFile } from './jira';
import { writeJsonAtomic, JsonStore } from './jsonFile';
import type { AppDeps, Bookmark, BookmarkFolder, SpeedDialTile, SavedTest, UpdateStatus } from './ipc/deps';
import { registerSessionsIpc } from './ipc/sessions';
import { registerRecordingIpc } from './ipc/recording';
import { registerA11yIpc } from './ipc/a11y';
import { registerMockIpc } from './ipc/mock';
import { registerResilienceIpc } from './ipc/resilience';
import { registerEmulationIpc } from './ipc/emulation';
import { registerVisualRegressionIpc } from './ipc/visualRegression';
import { registerDownloadsIpc } from './ipc/downloads';
import { registerPermissionsIpc } from './ipc/permissions';
import { registerBookmarksIpc } from './ipc/bookmarks';
import { registerLayoutIpc } from './ipc/layout';
import { registerSettingsIpc } from './ipc/settings';
import { registerAppIpc } from './ipc/app';
import { registerApplogIpc } from './ipc/applog';
import { registerJiraIpc } from './ipc/jira';
import { registerBugreportIpc, BugReportSettings } from './ipc/bugreport';
import { registerTestsIpc } from './ipc/tests';

let win: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;
let visualRegressionStore: VisualRegressionStore | null = null;

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

// #257: called as early as possible, before app.whenReady() (below) is ever
// reached. A losing second instance runs on the exact same --user-data-dir
// as the first (nothing distinguishes them), so without this a second
// taskbar click/shortcut launch would race the primary instance to write
// the same sentinel/settings/open-sessions files and open the same SQLite
// databases. e2e's launchApp() gives every test its own --user-data-dir, so
// parallel test workers never share a lock and are unaffected by this.
// ELECTRON_SKIP_SINGLE_INSTANCE=1 lets a test relaunch the app against the same
// user-data-dir (e.g. to check crash-log persistence) without hitting a stale
// lock left behind by a SIGKILL'd previous instance.
const gotSingleInstanceLock =
  process.env.ELECTRON_SKIP_SINGLE_INSTANCE === '1' || app.requestSingleInstanceLock();

// --- Privileged-IPC sender check (#217) ---
// src/preload/newtab.ts's contextBridge APIs (speedDial, appTheme, bookmarksApi,
// appSettings, appInfo) ride on NEWTAB_PRELOAD, which every WebContentsView uses.
// The preload only exposes them to renderer/newtab.html, but a compromised or
// hostile page could still send these channels directly. The handlers read/write
// app-wide state (settings, bookmarks, theme), so only two
// senders may call them: the chrome window itself (win.webContents, used by
// renderer/*.js) and a frame actually showing the new-tab page. Everything else —
// any site under test — is rejected. L1: the new-tab frame must be a top-level
// frame whose file: URL resolves to exactly the bundled newtab.html (see
// newtabUrl.ts), not merely contain that name.
function isTrustedIpcSender(e: IpcMainInvokeEvent): boolean {
  if (win && e.sender === win.webContents) return true;
  return isTrustedNewtabFrame(e.senderFrame);
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
  if (!sessionUrlsPath) return;
  const urls = (sessionManager?.listSessions() ?? []).map((s: { url?: string }) => s.url ?? '').filter(Boolean);
  writeJsonAtomic(sessionUrlsPath, urls);
}

// available-manual (#230): a newer release exists (found by the error
// handler's release-scan fallback below, when the newest release is
// missing latest.yml) but electron-updater has no update info to actually
// download it with — Settings links out to the GitHub release page
// instead of showing "downloading…", and the titlebar pill never appears
// for this status (there's nothing it could silently install).
let updateStatus: UpdateStatus = 'checking';
let latestVersion: string | null = null;
// #259: "install downloaded updates automatically when idle". Only ever
// running while settingsStore's autoInstallWhenIdle is on and updateStatus
// is 'downloaded' — see maybeStartIdleInstallTimer()/checkIdleInstall().
let idleInstallTimer: ReturnType<typeof setInterval> | null = null;
// Reset whenever the timer (re)starts, so a still-blocked check logs its
// reason once, not every 60s — but re-logs if the reason itself changes.
let lastIdleInstallBlockReason: string | null = null;

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

// JsonStore itself now lives in jsonFile.ts (#276) — see its own comment
// there for why (permissionManager.ts needs it without importing index.ts).

// --- Typed stores ---

// AppSettings itself lives in settingsPatch.ts (imported above) so the
// whitelist merge there can be unit tested without booting Electron; this
// comment block documents the fields for readers of this file.
// - redactSensitiveHeaders
//   A rule id absent from the map means "enabled" — new rules added later
//   need no migration, they just aren't in anyone's map yet.
// - securityRuleOverrides
// - securityIncludeSubresources
//   #240: header-presence/value rules (CSP, XFO, HSTS, ...) only apply to
//   Document responses by default — a missing CSP on a third-party image
//   isn't a real finding. Turning this on restores the old behaviour of
//   checking every unique HTTPS URL, subresources included.
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
// - recorderMaxEvents / recordingRetentionDays
//   SessionRecorder's per-tab ring-buffer cap and cleanupOldRecordings()'s
//   age cutoff (#229). Only applies to tabs opened after the change — an
//   already-open tab's recorder was already constructed with the old cap.
//   Clamped via clampNumberSetting() both on load (a hand-edited or stale
//   settings.json) and in applySettingsPatch() (settings:set).
// - autoOpenDownloadsPanel
//   #247: off by default — a download triggered incidentally by a page
//   under test no longer force-opens the downloads panel and narrows the
//   active page mid-test. The downloads button shows an unseen-download
//   badge instead; turning this on restores the old always-auto-open
//   behaviour.

const DEFAULT_SETTINGS: AppSettings = {
  redactSensitiveHeaders: false,
  securityRuleOverrides: {},
  securityIncludeSubresources: false,
  searchEngine: 'google',
  recordPlaybackColumnWidths: { record: 220, saved: 420 },
  debugMode: false,
  autoOpenDownloadsPanel: false,
  recorderMaxEvents: 20000,
  recordingRetentionDays: 30,
  autoInstallWhenIdle: false,
  allowRealPopups: false,
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
const settingsStore   = new JsonStore<AppSettings>('settings.json', DEFAULT_SETTINGS, (raw) => {
  const merged = { ...DEFAULT_SETTINGS, ...(raw as Partial<AppSettings>) };
  // #229: a hand-edited or stale settings.json could carry an out-of-range
  // or malformed value — clamp on load the same way settings:set does.
  merged.recorderMaxEvents = clampNumberSetting(
    merged.recorderMaxEvents, RECORDER_MAX_EVENTS_MIN, RECORDER_MAX_EVENTS_MAX, DEFAULT_SETTINGS.recorderMaxEvents
  );
  merged.recordingRetentionDays = clampNumberSetting(
    merged.recordingRetentionDays, RECORDING_RETENTION_DAYS_MIN, RECORDING_RETENTION_DAYS_MAX, DEFAULT_SETTINGS.recordingRetentionDays
  );
  return merged;
});

// The Jira API token is encrypted at rest via OS-level safeStorage (DPAPI /
// Keychain / libsecret), the same as the GitHub bug-reporter token below —
// only the ciphertext touches disk, and jira:getSettings never returns it
// to the renderer (see toPublicJiraSettings). A pre-#267 settings file with
// a plaintext apiToken is migrated to apiTokenEnc on first load.
let jiraTokenMigrated = false;
const jiraStore = new JsonStore<JiraSettingsFile>('jira-settings.json', DEFAULT_JIRA_SETTINGS, (raw) => {
  const { settings, migrated } = migrateJiraSettings(
    raw,
    (s) => safeStorage.encryptString(s),
    () => safeStorage.isEncryptionAvailable()
  );
  jiraTokenMigrated = migrated;
  return settings;
});
if (jiraTokenMigrated) jiraStore.set(jiraStore.get()); // persist the migration, dropping the plaintext token from disk

const testsStore = new JsonStore<SavedTest[]>('tests.json', []);

// GitHub token for the in-app bug reporter is encrypted at rest via OS-level
// safeStorage (DPAPI / Keychain / libsecret) — only the ciphertext touches disk.
// refreshTokenEnc is only populated when the GitHub OAuth App has "token
// expiration" enabled, in which case access tokens are short-lived (~8h) and
// must be renewed via the refresh token (itself valid ~6 months) instead of
// forcing the user back through the device-flow sign-in.
const DEFAULT_BUGREPORT: BugReportSettings = { tokenEnc: null, refreshTokenEnc: null, refreshExpiresAt: null };
const bugReportStore = new JsonStore<BugReportSettings>('bugreport-settings.json', DEFAULT_BUGREPORT,
  (raw) => ({ ...DEFAULT_BUGREPORT, ...(raw as Partial<BugReportSettings>) }));

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

  sessionManager = new SessionManager(
    win, () => settingsStore.get().redactSensitiveHeaders, log, persistSessionUrls,
    () => settingsStore.get().recorderMaxEvents,
    () => settingsStore.get().allowRealPopups
  );
  visualRegressionStore = new VisualRegressionStore(win);

  const restored = sessionManager.loadAndRestoreSessions();
  if (!restored) {
    const first = sessionManager.createSession('Default', { persistent: true });
    sessionManager.switchTo(first.id);
  }
  // #229: runs on every startup regardless of whether a restore happened —
  // previously only ran from inside loadAndRestoreSessions(), so a user who
  // started with no saved tabs never got old recordings cleaned up.
  sessionManager.cleanupOldRecordings(settingsStore.get().recordingRetentionDays)
    .catch((e) => log.warn('sessions', 'Failed to clean up old recordings on startup', { error: String(e) }));

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

if (!gotSingleInstanceLock) {
  // Losing the lock means another instance is already running against this
  // same user-data dir — quit before app.whenReady() ever fires, so none of
  // its sentinel/crash-log/store bookkeeping below runs a second time
  // against files the primary instance already owns.
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();

    const url = firstHttpUrl(argv);
    if (url && sessionManager) {
      const ns = sessionManager.createSession(getHostname(url), { startUrl: url, persistent: true });
      win.webContents.send('session:newTab', { id: ns.id });
    }
  });

  app.whenReady().then(() => {
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
        maybeStartIdleInstallTimer();
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
                  // #230: electron-updater has no update info to download this from (it
                  // errored on the newest release's own latest.yml) — 'available-manual'
                  // points the user at the GitHub release page instead of pretending a
                  // real download is in progress.
                  const newer = isVersionNewer(foundVersion, app.getVersion());
                  updateStatus = newer ? 'available-manual' : 'not-available';
                  pushUpdateStatus();
                  log.info('updater', newer
                    ? `Update found via release scan (manual download required): ${foundVersion}`
                    : `Release scan found ${foundVersion}, not newer than current`);
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
        // #228: ctx here is the update log's data source (app:getUpdateLog
        // reconstructs { timestamp, status, message, currentVersion,
        // latestVersion } from source='updater' rows via toUpdateLogEntry()).
        log.error('updater', fullMsg, { status: 'error', currentVersion: app.getVersion(), latestVersion: null });
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
}

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


// Shared by the pill/Settings-triggered restart and #259's idle auto-install
// — both just want "persist, then silently install and relaunch."
function restartAndInstall() {
  // Persist state before quitAndInstall() tears the process down — it calls
  // app.quit() itself, but does so via setImmediate after starting the
  // installer, not through the normal before-quit path in time to matter,
  // so the persisted state has to already be on disk before this returns.
  sessionManager?.saveSessions();
  persistSessionUrls();
  autoUpdater.quitAndInstall(true, true);
}

function checkForUpdatesNow() {
  if (!app.isPackaged) return;
  updateStatus = 'checking'; latestVersion = null;
  pushUpdateStatus();
  autoUpdater.checkForUpdates();
}

// #259: started once an update reaches 'downloaded' while the setting is on
// (see the 'update-downloaded' handler above and settings:set in
// ipc/settings.ts), stopped once either stops holding. Checks, rather than
// reacting to idle events, since idle *time* (not a single idle/resume edge)
// and the several other busy-conditions all need to hold at once, at the
// moment a real install would happen.
function maybeStartIdleInstallTimer() {
  if (idleInstallTimer) return;
  if (!settingsStore.get().autoInstallWhenIdle || updateStatus !== 'downloaded') return;
  lastIdleInstallBlockReason = null;
  idleInstallTimer = setInterval(checkIdleInstall, 60_000);
}
function stopIdleInstallTimer() {
  if (!idleInstallTimer) return;
  clearInterval(idleInstallTimer);
  idleInstallTimer = null;
}
function checkIdleInstall() {
  const settings = settingsStore.get();
  if (!settings.autoInstallWhenIdle || updateStatus !== 'downloaded') {
    // The setting was turned off, or a fresh update check moved status on —
    // per the acceptance criteria, the check simply stops; a future
    // 'downloaded'/settings:set will start a fresh timer as needed.
    stopIdleInstallTimer();
    return;
  }
  const downloads = sessionManager?.listDownloads() ?? [];
  const busy = sessionManager?.isBusy() ?? { recording: false, following: false, playing: false };
  const decision = canAutoInstall({
    enabled: settings.autoInstallWhenIdle,
    status: updateStatus,
    idleSeconds: powerMonitor.getSystemIdleTime(),
    recording: busy.recording,
    following: busy.following,
    playing: busy.playing,
    downloading: downloads.some((d) => d.state === 'progressing'),
  });
  if (decision.ok) {
    stopIdleInstallTimer();
    log.info('updater', `Auto-installing update while idle (idle ${IDLE_INSTALL_MINUTES}+ min)`);
    restartAndInstall();
    return;
  }
  if (decision.reason && decision.reason !== lastIdleInstallBlockReason) {
    lastIdleInstallBlockReason = decision.reason;
    log.info('updater', `Auto-install blocked: ${decision.reason}`);
  }
}

// --- IPC surface ---
// #255/#283: registrations themselves live in src/main/ipc/<feature>.ts,
// each a register(deps) function taking whatever narrow slice of this
// file's state it needs — this file shrinks to bootstrap, store
// construction, and this one sequence of register calls. Called at module
// load (matching where these handlers registered before this split), not
// deferred to app.whenReady() — every dependency below is a getter closure
// over a `let`, so it's read fresh at call time regardless of when
// createWindow() actually constructs sessionManager/win.

const appDeps: AppDeps = {
  getWin: () => win,
  getSessionManager: () => sessionManager,
  getVisualRegressionStore: () => visualRegressionStore,
  getDebugLogStore: () => debugLogStore,
  getLogsDir: () => logsDir,
  log,
  recordAppError,
  persistSessionUrls,
  rejectUntrustedSender,
};

registerSessionsIpc(appDeps);
registerRecordingIpc(appDeps);
registerA11yIpc(appDeps);
registerMockIpc(appDeps);
registerResilienceIpc(appDeps);
registerEmulationIpc(appDeps);
registerVisualRegressionIpc(appDeps);
registerDownloadsIpc(appDeps);
registerPermissionsIpc(appDeps);
registerBookmarksIpc(appDeps, { bookmarkStore, bookmarkFoldersStore, urlHistoryStore, speedDialStore });
registerLayoutIpc(appDeps);
registerSettingsIpc(appDeps, { settingsStore, themeStore, maybeStartIdleInstallTimer });
registerAppIpc(appDeps, {
  getUpdateStatus: () => updateStatus,
  getLatestVersion: () => latestVersion,
  checkForUpdatesNow,
  restartAndInstall,
  getCrashLogPath: () => crashLogPath,
});
registerApplogIpc(appDeps);
registerJiraIpc(appDeps, { jiraStore });
registerBugreportIpc(appDeps, { bugReportStore });
registerTestsIpc(appDeps, { testsStore });
