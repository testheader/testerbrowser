import { app, BrowserWindow, ipcMain, Menu, clipboard, net, safeStorage, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { autoUpdater } from 'electron-updater';
import { SessionManager, TestStep } from './sessionManager';
import { writeUpdateLog, readUpdateLog } from './updateLogger';

let win: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;

// --- App-level error log (for bug reports — main process errors, not site console errors) ---

interface AppErrorEntry { ts: number; message: string; }
const MAX_APP_ERRORS = 20;
const recentAppErrors: AppErrorEntry[] = [];
function recordAppError(message: string) {
  recentAppErrors.push({ ts: Date.now(), message: String(message).slice(0, 2000) });
  if (recentAppErrors.length > MAX_APP_ERRORS) recentAppErrors.shift();
}
process.on('uncaughtException', (err) => recordAppError(`Uncaught exception: ${err?.stack ?? err?.message ?? String(err)}`));
process.on('unhandledRejection', (reason) => recordAppError(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`));

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

interface JiraSettings { baseUrl: string; email: string; apiToken: string; projectKey: string; }
const DEFAULT_JIRA: JiraSettings = { baseUrl: '', email: '', apiToken: '', projectKey: '' };
const jiraStore = new JsonStore<JiraSettings>('jira-settings.json', DEFAULT_JIRA,
  (raw) => ({ ...DEFAULT_JIRA, ...(raw as Partial<JiraSettings>) }));

interface SavedTest { id: string; name: string; steps: object[]; createdAt: number; updatedAt: number; }
const testsStore = new JsonStore<SavedTest[]>('tests.json', []);

// GitHub token for the in-app bug reporter is encrypted at rest via OS-level
// safeStorage (DPAPI / Keychain / libsecret) — only the ciphertext touches disk.
interface BugReportSettings { tokenEnc: string | null; }
const DEFAULT_BUGREPORT: BugReportSettings = { tokenEnc: null };
const bugReportStore = new JsonStore<BugReportSettings>('bugreport-settings.json', DEFAULT_BUGREPORT,
  (raw) => ({ ...DEFAULT_BUGREPORT, ...(raw as Partial<BugReportSettings>) }));

function getGithubToken(): string | null {
  const s = bugReportStore.get();
  if (!s.tokenEnc || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(s.tokenEnc, 'base64')); } catch { return null; }
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
  updateLogFile = path.join(app.getPath('userData'), 'update-errors.jsonl');
  createWindow();

  if (app.isPackaged) {
    autoUpdater.allowPrerelease = true;
    // electron-updater's own "update-available" signal isn't trusted blindly — a stale feed
    // or a version tag mishap can fire it for the version already running. Downloading (and
    // therefore reinstalling) only proceeds once we've independently confirmed it's newer.
    autoUpdater.autoDownload = false;
    autoUpdater.on('checking-for-update', () => { updateStatus = 'checking'; latestVersion = null; pushUpdateStatus(); });
    autoUpdater.on('update-available', (info) => {
      latestVersion = info.version;
      if (!isVersionNewer(info.version, app.getVersion())) {
        updateStatus = 'not-available';
        pushUpdateStatus();
        return;
      }
      updateStatus = 'available';
      pushUpdateStatus();
      autoUpdater.downloadUpdate();
    });
    autoUpdater.on('download-progress', () => { updateStatus = 'downloading'; pushUpdateStatus(); });
    autoUpdater.on('update-downloaded', (info) => { updateStatus = 'downloaded'; latestVersion = info.version; pushUpdateStatus(); });
    autoUpdater.on('update-not-available', (info) => { updateStatus = 'not-available'; latestVersion = info.version; pushUpdateStatus(); });
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
        } catch {}
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
      } catch {}
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
ipcMain.handle('a11y:getTree',        (_e, id: string) => sessionManager?.getA11yTree(id) ?? null);
ipcMain.handle('a11y:setInspect',     (_e, id: string, enabled: boolean) => sessionManager?.setA11yInspect(id, enabled));
ipcMain.handle('session:captureScreenshot', (_e, id: string, opts?: { fullPage?: boolean }) => sessionManager?.captureScreenshot(id, opts) ?? null);
ipcMain.handle('testdata:apply',      (_e, id: string, template: string) => sessionManager?.applyTemplate(id, template));
ipcMain.handle('mock:getRules',    (_e, id: string) => sessionManager?.getMockRules(id) ?? []);
ipcMain.handle('mock:addRule',     (_e, id: string, rule) => sessionManager?.addMockRule(id, rule));
ipcMain.handle('mock:removeRule',  (_e, id: string, ruleId: string) => sessionManager?.removeMockRule(id, ruleId));
ipcMain.handle('mock:toggleRule',  (_e, id: string, ruleId: string, enabled: boolean) => sessionManager?.toggleMockRule(id, ruleId, enabled));
ipcMain.handle('resilience:getRules',    (_e, id: string) => sessionManager?.getResilienceRules(id) ?? []);
ipcMain.handle('resilience:addRule',     (_e, id: string, rule) => sessionManager?.addResilienceRule(id, rule));
ipcMain.handle('resilience:removeRule',  (_e, id: string, ruleId: string) => sessionManager?.removeResilienceRule(id, ruleId));
ipcMain.handle('resilience:toggleRule',  (_e, id: string, ruleId: string, enabled: boolean) => sessionManager?.toggleResilienceRule(id, ruleId, enabled));
ipcMain.handle('resilience:updateRule',  (_e, id: string, ruleId: string, patch) => sessionManager?.updateResilienceRule(id, ruleId, patch));
ipcMain.handle('session:setEmulation', (_e, id: string, opts: { timezone?: string; locale?: string; latitude?: number; longitude?: number; accuracy?: number; clear?: boolean }) => sessionManager?.setEmulation(id, opts));
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

ipcMain.handle('bugreport:hasToken', () => !!bugReportStore.get().tokenEnc);

ipcMain.handle('bugreport:saveToken', (_e, token: string) => {
  const trimmed = (token ?? '').trim();
  if (!trimmed) { bugReportStore.set({ tokenEnc: null }); return { ok: true }; }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS-level secure storage is unavailable on this system — cannot store the token safely.' };
  }
  bugReportStore.set({ tokenEnc: safeStorage.encryptString(trimmed).toString('base64') });
  return { ok: true };
});

ipcMain.handle('bugreport:getDiagnostics', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  recentErrors: recentAppErrors.slice(-10),
}));

ipcMain.handle('app:captureScreenshot', () => sessionManager?.captureAppScreenshot() ?? null);

function diagnosticsBlock(area: string): string {
  const d = {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    recentErrors: recentAppErrors.slice(-10),
  };
  const lines = [
    `TesterBrowser: ${d.version}`,
    `Electron: ${d.electron}  Chrome: ${d.chrome}  Node: ${d.node}`,
    `OS: ${d.platform} ${d.arch} (${d.osRelease})`,
    `Feature area: ${area}`,
    '',
    d.recentErrors.length
      ? `Recent app errors:\n${d.recentErrors.map(e => `[${new Date(e.ts).toISOString()}] ${e.message}`).join('\n')}`
      : 'No recent app errors recorded.',
  ];
  return ['<details><summary>Diagnostics</summary>', '', '```', ...lines, '```', '</details>'].join('\n');
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

ipcMain.handle('bugreport:submit', async (_e, payload: { area: string; description: string; screenshotB64?: string | null }) => {
  const token = getGithubToken();
  if (!token) return { ok: false, error: 'No GitHub token configured. Add one in Settings.' };
  if (!payload?.description?.trim()) return { ok: false, error: 'Description is required.' };

  const title = `[${payload.area}] ${payload.description.trim().split('\n')[0].slice(0, 80)}`;
  const body = `${payload.description.trim()}\n\n${diagnosticsBlock(payload.area)}`;

  try {
    const res = await net.fetch(`https://api.github.com/repos/${GH_REPO_OWNER}/${GH_REPO_NAME}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'TesterBrowser-BugReporter',
      },
      body: JSON.stringify({ title, body }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: (data as { message?: string }).message ?? `HTTP ${res.status}` };

    let screenshotUrl: string | null = null;
    if (payload.screenshotB64) {
      try {
        const filePath = `.github/bug-report-screenshots/issue-${data.number}.png`;
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
        if (putRes.ok) {
          screenshotUrl = `https://raw.githubusercontent.com/${GH_REPO_OWNER}/${GH_REPO_NAME}/main/${filePath}`;
          await net.fetch(`https://api.github.com/repos/${GH_REPO_OWNER}/${GH_REPO_NAME}/issues/${data.number}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json',
              'Content-Type': 'application/json',
              'User-Agent': 'TesterBrowser-BugReporter',
            },
            body: JSON.stringify({ body: `${body}\n\n![TesterBrowser screenshot](${screenshotUrl})` }),
          });
        }
      } catch { /* screenshot attach is best-effort */ }
    }

    const boardAdded = await addIssueToProjectBoard(token, data.node_id as string);
    return { ok: true, url: data.html_url, number: data.number, boardAdded };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

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

// Window control IPC
ipcMain.handle('window:minimize', () => win?.minimize());
ipcMain.handle('window:maximize', () => { if (win?.isMaximized()) win.unmaximize(); else win?.maximize(); });
ipcMain.handle('window:close',    () => win?.close());

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
  autoUpdater.checkForUpdates();
});
ipcMain.handle('app:restartAndInstall', () => autoUpdater.quitAndInstall());
ipcMain.handle('app:openExternal', (_e, url: string) => {
  if (/^https:\/\//i.test(url ?? '')) shell.openExternal(url);
});

// Tests (record-playback) IPC
ipcMain.handle('tests:list', () => testsStore.get());
ipcMain.handle('tests:save', (_e, test: SavedTest) => {
  testsStore.update(all => {
    const idx = all.findIndex(t => t.id === test.id);
    if (idx >= 0) { all[idx] = test; return all; }
    return [...all, test];
  });
});
ipcMain.handle('tests:load', (_e, id: string) => testsStore.get().find(t => t.id === id) ?? null);
ipcMain.handle('tests:delete', (_e, id: string) => testsStore.update(all => all.filter(t => t.id !== id)));
ipcMain.handle('session:startRecording',     (_e, id: string) => sessionManager?.startRecording(id) ?? null);
ipcMain.handle('session:stopRecording',      (_e, id: string) => sessionManager?.stopRecording(id) ?? []);
ipcMain.handle('session:pollRecordingSteps', (_e, id: string) => sessionManager?.pollRecordingSteps(id) ?? []);
ipcMain.handle('session:playbackStep',       (_e, id: string, step: TestStep) => sessionManager?.playbackStep(id, step) ?? null);

// Settings IPC
ipcMain.handle('settings:get', () => settingsStore.get());
ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) =>
  settingsStore.update(s => ({ ...s, ...patch }))
);

// Update log IPC
ipcMain.handle('app:getUpdateLog', () => updateLogFile ? readUpdateLog(updateLogFile) : []);
