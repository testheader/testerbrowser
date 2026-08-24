import { BrowserWindow, WebContentsView, session as electronSession, Menu, shell, clipboard } from 'electron';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { SessionRecorder } from './recorder';

export interface TestSession {
  id: string;
  name: string;
  persistent: boolean;
  partition: string;
  currentUrl: string;
  pinned: boolean;
  color: string;
  view: WebContentsView;
  recorder: SessionRecorder;
  createdAt: number;
}

interface DownloadInfo {
  id: string;
  filename: string;
  url: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
  savePath: string;
  item?: Electron.DownloadItem;
}

const TAB_COLORS = [
  '#e06c75', '#61afef', '#98c379', '#c678dd',
  '#e5c07b', '#56b6c2', '#d19a66', '#be5046',
  '#2bbac5', '#d4896a',
];

function getHostname(url: string): string {
  try { return new URL(url).hostname || 'New tab'; } catch { return 'New tab'; }
}

// Resolved at runtime — points to renderer/newtab.html whether packaged or in dev
const NEWTAB_FILE = path.join(__dirname, '..', '..', 'renderer', 'newtab.html');
const NEWTAB_PRELOAD = path.join(__dirname, '..', 'preload', 'newtab.js');

function isNewtabUrl(url: string) {
  return url.startsWith('file://') && url.includes('newtab.html');
}

function isSafeUrl(url: string): boolean {
  try { const { protocol } = new URL(url); return protocol === 'http:' || protocol === 'https:'; }
  catch { return false; }
}

export class SessionManager {
  private win: BrowserWindow;
  private sessions = new Map<string, TestSession>();
  private activeId: string | null = null;
  private dbDir: string;
  private consoleHeight = 220;
  private topBarHeight = 88;
  private isViewVisible = true;
  private sessionNotes = new Map<string, string>();
  private colorIndex = 0;
  private downloads = new Map<string, DownloadInfo>();
  private pendingPermissions = new Map<string, { callback: (granted: boolean) => void; permission: string; partition: string; origin: string }>();
  private grantedPermissions = new Map<string, Set<string>>();

  constructor(win: BrowserWindow) {
    this.win = win;
    this.dbDir = path.join(app.getPath('userData'), 'recordings');
    this.win.on('resize', () => this.layoutActive());
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      persistent: s.persistent,
      partition: s.partition,
      url: s.currentUrl,
      pinned: s.pinned,
      color: s.color,
      createdAt: s.createdAt,
    }));
  }

  createSession(
    name: string,
    opts: { persistent?: boolean; startUrl?: string; partition?: string; color?: string } = {}
  ): TestSession {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partition = opts.partition ?? (opts.persistent ? `persist:${id}` : id);
    const ses = electronSession.fromPartition(partition);

    // Download handling — auto-save to system Downloads folder
    ses.on('will-download', (_event, item) => {
      const dlId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // path.basename strips any directory traversal from server-supplied filenames
      const rawName = path.basename(item.getFilename()) || 'download';
      const dlDir = app.getPath('downloads');
      const ext = path.extname(rawName);
      const base = path.basename(rawName, ext);
      let savePath = path.join(dlDir, rawName);
      let counter = 1;
      while (fs.existsSync(savePath)) {
        savePath = path.join(dlDir, `${base} (${counter++})${ext}`);
      }
      item.setSavePath(savePath);
      const filename = path.basename(savePath);

      const dl: DownloadInfo = {
        id: dlId, filename, url: item.getURL(),
        state: 'progressing', receivedBytes: 0,
        totalBytes: item.getTotalBytes(), savePath, item,
      };
      this.downloads.set(dlId, dl);
      this.pushDownload(dl);

      item.on('updated', (_e, state) => {
        dl.state = state as 'progressing' | 'interrupted';
        dl.receivedBytes = item.getReceivedBytes();
        dl.totalBytes = item.getTotalBytes();
        this.pushDownload(dl);
      });
      item.on('done', (_e, state) => {
        dl.state = state as 'completed' | 'cancelled' | 'interrupted';
        dl.receivedBytes = item.getReceivedBytes();
        dl.savePath = item.getSavePath();
        dl.item = undefined;
        this.pushDownload(dl);
      });
    });

    // Permission handling — auto-grant fullscreen/pointer lock, prompt for the rest
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      if (permission === 'fullscreen' || permission === 'pointerLock') {
        callback(true);
        return;
      }
      const reqId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const requestingUrl = details?.requestingUrl ?? '';
      let origin = '';
      try { origin = new URL(requestingUrl).origin; } catch {}
      const originLabel = origin || getHostname(requestingUrl) || 'This page';
      this.pendingPermissions.set(reqId, { callback, permission, partition, origin });
      this.win.webContents.send('permission:request', { reqId, permission, origin: originLabel });
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      return this.grantedPermissions.get(`${partition}|${requestingOrigin}`)?.has(permission) ?? false;
    });

    const view = new WebContentsView({
      webPreferences: { session: ses, contextIsolation: true, sandbox: true, preload: NEWTAB_PRELOAD },
    });

    const recorder = new SessionRecorder(view.webContents, { sessionId: id, dbDir: this.dbDir });

    const color = opts.color ?? TAB_COLORS[this.colorIndex++ % TAB_COLORS.length];
    const testSession: TestSession = {
      id, name,
      persistent: !!opts.persistent || partition.startsWith('persist:'),
      partition,
      currentUrl: opts.startUrl || '',
      pinned: false,
      color,
      view, recorder,
      createdAt: Date.now(),
    };
    this.sessions.set(id, testSession);

    if (opts.startUrl) {
      view.webContents.loadURL(opts.startUrl);
    } else {
      view.webContents.loadFile(NEWTAB_FILE);
    }

    view.webContents.on('did-navigate', (_e, url) => {
      const displayUrl = isNewtabUrl(url) ? '' : url;
      testSession.currentUrl = displayUrl;
      this.win.webContents.send('session:navigated', { id, url: displayUrl });
      this.sendNavState(id);
    });
    view.webContents.on('did-navigate-in-page', (_e, url) => {
      const displayUrl = isNewtabUrl(url) ? '' : url;
      testSession.currentUrl = displayUrl;
      this.win.webContents.send('session:navigated', { id, url: displayUrl });
      this.sendNavState(id);
    });
    view.webContents.on('page-title-updated', (_e, title) => {
      this.win.webContents.send('session:titleUpdated', { id, title });
    });
    view.webContents.on('page-favicon-updated', (_e, favicons) => {
      if (favicons[0]) this.win.webContents.send('session:faviconUpdated', { id, favicon: favicons[0] });
    });
    view.webContents.on('found-in-page', (_e, result) => {
      this.win.webContents.send('find:result', {
        id, matches: result.matches ?? 0, activeMatch: result.activeMatchOrdinal ?? 0,
      });
    });

    // Loading state
    view.webContents.on('did-start-loading', () => {
      this.win.webContents.send('session:loading', { id, loading: true });
    });
    view.webContents.on('did-stop-loading', () => {
      this.win.webContents.send('session:loading', { id, loading: false });
    });

    // Navigation failure
    view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // ignore subframe failures and user-aborted
      this.win.webContents.send('session:loadFailed', { id, errorCode, errorDescription, url: validatedURL });
    });

    // Right-click context menu on page
    view.webContents.on('context-menu', (_e, params) => {
      const items: Electron.MenuItemConstructorOptions[] = [];

      if (params.linkURL) {
        items.push({ label: 'Open link in new tab', click: () => {
          if (!isSafeUrl(params.linkURL)) return;
          const ns = this.createSession(getHostname(params.linkURL), { partition, startUrl: params.linkURL, color });
          this.switchTo(ns.id);
          this.win.webContents.send('session:newTab', { id: ns.id });
        }});
        items.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
        items.push({ type: 'separator' });
      }

      if (params.mediaType === 'image' && params.srcURL) {
        items.push({ label: 'Open image in new tab', click: () => {
          if (!isSafeUrl(params.srcURL)) return;
          const ns = this.createSession('Image', { partition, startUrl: params.srcURL });
          this.switchTo(ns.id);
          this.win.webContents.send('session:newTab', { id: ns.id });
        }});
        items.push({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) });
        items.push({ type: 'separator' });
      }

      if (params.isEditable) {
        items.push({ label: 'Cut',        click: () => view.webContents.cut() });
        items.push({ label: 'Copy',       click: () => view.webContents.copy() });
        items.push({ label: 'Paste',      click: () => view.webContents.paste() });
        items.push({ label: 'Select All', click: () => view.webContents.selectAll() });
        items.push({ type: 'separator' });
      } else if (params.selectionText) {
        items.push({ label: 'Copy', click: () => view.webContents.copy() });
        items.push({ type: 'separator' });
      }

      items.push({ label: 'Back',    enabled: view.webContents.canGoBack(),    click: () => view.webContents.goBack() });
      items.push({ label: 'Forward', enabled: view.webContents.canGoForward(), click: () => view.webContents.goForward() });
      items.push({ label: 'Reload',  click: () => view.webContents.reload() });
      items.push({ type: 'separator' });
      items.push({ label: 'Inspect Element', click: () => {
        if (!view.webContents.isDevToolsOpened()) view.webContents.openDevTools();
      }});

      Menu.buildFromTemplate(items).popup({ window: this.win });
    });

    view.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const { control: ctrl, shift, alt, key } = input;
      const send = (name: string) => { event.preventDefault(); this.win.webContents.send('app:shortcut', name); };

      if (ctrl && key === 'Tab')            { event.preventDefault(); this.win.webContents.send('tabs:cycle', { reverse: shift }); return; }
      if (ctrl && !shift && key === 't')    { send('newTab'); return; }
      if (ctrl && !shift && key === 'w')    { send('closeTab'); return; }
      if (ctrl && shift  && key === 'T')    { send('reopenTab'); return; }
      if (ctrl && key === 'l')              { send('focusUrl'); return; }
      if (ctrl && key === 'f')              { send('findToggle'); return; }
      if (ctrl && !shift && key === 'd')    { send('bookmark'); return; }
      if (ctrl && shift  && key === 'B')    { send('toggleBookmarksBar'); return; }
      if (key === 'F3')                     { send(shift ? 'findPrev' : 'findNext'); return; }
      if ((ctrl && key === 'r') || key === 'F5') { send('reload'); return; }
      if (key === 'Escape')                 { send('stopOrEsc'); return; }
      if (key === 'F12')                    { event.preventDefault(); this.toggleDevTools(this.activeId ?? ''); return; }
      if (ctrl && (key === '=' || key === '+')) { event.preventDefault(); this.setZoom(this.activeId ?? '', 0.1); return; }
      if (ctrl && key === '-')              { event.preventDefault(); this.setZoom(this.activeId ?? '', -0.1); return; }
      if (ctrl && key === '0')              { event.preventDefault(); this.resetZoom(this.activeId ?? ''); return; }
      if (alt && key === 'ArrowLeft')       { event.preventDefault(); this.back(this.activeId ?? ''); return; }
      if (alt && key === 'ArrowRight')      { event.preventDefault(); this.forward(this.activeId ?? ''); return; }
      // Ctrl+1–9 tab switching
      if (ctrl && key >= '1' && key <= '9') { send(`switchTab:${key}`); return; }
    });

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeUrl(url)) {
        setImmediate(() => {
          const newSession = this.createSession(getHostname(url), { partition, startUrl: url, color });
          this.switchTo(newSession.id);
          this.win.webContents.send('session:newTab', { id: newSession.id });
        });
      }
      return { action: 'deny' };
    });

    return testSession;
  }

  private sendNavState(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.win.webContents.send('session:navState', {
      id,
      canBack: s.view.webContents.canGoBack(),
      canForward: s.view.webContents.canGoForward(),
    });
  }

  private pushDownload(dl: DownloadInfo) {
    this.win.webContents.send('download:update', {
      id: dl.id, filename: dl.filename, url: dl.url,
      state: dl.state, receivedBytes: dl.receivedBytes,
      totalBytes: dl.totalBytes, savePath: dl.savePath,
    });
  }

  // --- Download actions ---

  openDownload(id: string)   { const dl = this.downloads.get(id); if (dl?.savePath) shell.openPath(dl.savePath); }
  revealDownload(id: string) { const dl = this.downloads.get(id); if (dl?.savePath) shell.showItemInFolder(dl.savePath); }
  cancelDownload(id: string) { this.downloads.get(id)?.item?.cancel(); }
  clearDownloads() {
    for (const [id, dl] of this.downloads) if (dl.state !== 'progressing') this.downloads.delete(id);
    this.win.webContents.send('download:cleared');
  }
  listDownloads() {
    return Array.from(this.downloads.values()).map(dl => ({
      id: dl.id, filename: dl.filename, url: dl.url,
      state: dl.state, receivedBytes: dl.receivedBytes,
      totalBytes: dl.totalBytes, savePath: dl.savePath,
    }));
  }

  // --- Permission ---

  respondPermission(reqId: string, granted: boolean) {
    const entry = this.pendingPermissions.get(reqId);
    if (!entry) return;
    entry.callback(granted);
    if (granted) {
      const key = `${entry.partition}|${entry.origin}`;
      if (!this.grantedPermissions.has(key)) this.grantedPermissions.set(key, new Set());
      this.grantedPermissions.get(key)!.add(entry.permission);
    }
    this.pendingPermissions.delete(reqId);
  }

  // --- Session management ---

  renameSession(id: string, name: string) {
    const s = this.sessions.get(id);
    if (s) s.name = name.trim() || s.name;
  }

  pinSession(id: string, pinned: boolean) {
    const s = this.sessions.get(id);
    if (s) s.pinned = pinned;
  }

  back(id: string)    { this.sessions.get(id)?.view.webContents.goBack(); }
  forward(id: string) { this.sessions.get(id)?.view.webContents.goForward(); }
  reload(id: string)  { this.sessions.get(id)?.view.webContents.reload(); }
  stop(id: string)    { this.sessions.get(id)?.view.webContents.stop(); }

  setZoom(id: string, delta: number) {
    const s = this.sessions.get(id);
    if (!s) return;
    const cur = s.view.webContents.getZoomFactor();
    const next = Math.max(0.25, Math.min(5, Math.round((cur + delta) * 10) / 10));
    s.view.webContents.setZoomFactor(next);
    this.win.webContents.send('session:zoomChanged', { id, zoom: next });
  }

  resetZoom(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.view.webContents.setZoomFactor(1);
    this.win.webContents.send('session:zoomChanged', { id, zoom: 1 });
  }

  getZoom(id: string): number {
    return this.sessions.get(id)?.view.webContents.getZoomFactor() ?? 1;
  }

  toggleDevTools(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.view.webContents.isDevToolsOpened() ? s.view.webContents.closeDevTools() : s.view.webContents.openDevTools();
  }

  findInPage(id: string, text: string, forward = true, findNext = false) {
    const s = this.sessions.get(id);
    if (!s || !text) return;
    s.view.webContents.findInPage(text, { forward, findNext });
  }
  stopFind(id: string) { this.sessions.get(id)?.view.webContents.stopFindInPage('clearSelection'); }

  setNotes(id: string, notes: string) { this.sessionNotes.set(id, notes); }
  getNotes(id: string) { return this.sessionNotes.get(id) ?? ''; }

  showContextMenu(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    const send = (action: string) => this.win.webContents.send('tab:action', { action, id });
    Menu.buildFromTemplate([
      { label: 'Rename',              click: () => send('rename') },
      { label: s.pinned ? 'Unpin' : 'Pin', click: () => {
        s.pinned = !s.pinned;
        this.win.webContents.send('tab:action', { action: 'refresh' });
      }},
      { type: 'separator' },
      { label: 'Clone', click: async () => {
        const c = await this.cloneSession(id, s.name + ' (clone)');
        if (c) this.win.webContents.send('session:newTab', { id: c.id });
      }},
      { label: 'Notes…', click: () => send('notes') },
      { type: 'separator' },
      { label: 'Close', enabled: !s.pinned, click: () => send('close') },
    ]).popup({ window: this.win });
  }

  // --- Persist sessions across restarts ---

  private get sessionsFile() {
    return path.join(app.getPath('userData'), 'open-sessions.json');
  }

  saveSessions() {
    try {
      const sessions = Array.from(this.sessions.values())
        .filter(s => s.persistent)
        .map(s => ({ name: s.name, partition: s.partition, url: s.currentUrl }));
      const notes: Record<string, string> = {};
      for (const [id, note] of this.sessionNotes) {
        const s = this.sessions.get(id);
        if (s && note) notes[s.partition] = note;
      }
      fs.writeFileSync(this.sessionsFile, JSON.stringify({ sessions, notes }));
    } catch {}
  }

  loadAndRestoreSessions(): boolean {
    try {
      if (!fs.existsSync(this.sessionsFile)) return false;
      const { sessions, notes } = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf-8'));
      if (!sessions?.length) return false;
      for (const s of sessions) {
        const sess = this.createSession(s.name, { partition: s.partition, startUrl: s.url });
        if (notes?.[s.partition]) this.sessionNotes.set(sess.id, notes[s.partition]);
      }
      const first = this.sessions.values().next().value as TestSession | undefined;
      if (first) this.switchTo(first.id);
      return true;
    } catch { return false; }
  }

  // --- Layout ---

  switchTo(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (this.activeId) {
      const prev = this.sessions.get(this.activeId);
      if (prev) this.win.contentView.removeChildView(prev.view);
    }
    this.activeId = id;
    if (this.isViewVisible) {
      this.win.contentView.addChildView(s.view);
      this.layoutActive();
    }
    this.sendNavState(id);
    this.win.webContents.send('session:zoomChanged', { id, zoom: s.view.webContents.getZoomFactor() });
  }

  private layoutActive() {
    if (!this.activeId || !this.isViewVisible) return;
    const s = this.sessions.get(this.activeId);
    if (!s) return;
    const bounds = this.win.getContentBounds();
    s.view.setBounds({
      x: 0,
      y: this.topBarHeight,
      width: bounds.width,
      height: Math.max(0, bounds.height - this.topBarHeight - this.consoleHeight),
    });
  }

  setConsoleHeight(height: number) {
    this.consoleHeight = height === 0 ? 0 : Math.max(80, Math.min(height, 600));
    this.layoutActive();
  }

  setTopBarHeight(height: number) {
    this.topBarHeight = Math.max(88, height);
    this.layoutActive();
  }

  setViewerVisible(visible: boolean) {
    this.isViewVisible = visible;
    if (!this.activeId) return;
    const s = this.sessions.get(this.activeId);
    if (!s) return;
    if (visible) { this.win.contentView.addChildView(s.view); this.layoutActive(); }
    else { this.win.contentView.removeChildView(s.view); }
  }

  async cloneSession(sourceId: string, newName: string): Promise<TestSession | null> {
    const src = this.sessions.get(sourceId);
    if (!src) return null;
    const dest = this.createSession(newName, { persistent: src.persistent });
    const cookies = await src.view.webContents.session.cookies.get({});
    for (const c of cookies) {
      const url = `${c.secure ? 'https' : 'http'}://${c.domain?.replace(/^\./, '')}${c.path}`;
      try {
        await dest.view.webContents.session.cookies.set({
          url, name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate,
        });
      } catch {}
    }
    return dest;
  }

  navigate(id: string, url: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.view.webContents.loadURL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  }

  getTimeline(id: string, opts?: { limit?: number; since?: number }) {
    return this.sessions.get(id)?.recorder.getTimeline(opts) ?? [];
  }

  getHAR(id: string): object | null {
    return this.sessions.get(id)?.recorder.exportHAR() ?? null;
  }

  async getCookies(id: string) {
    const s = this.sessions.get(id);
    if (!s) return [];
    return s.view.webContents.session.cookies.get({});
  }

  async getLocalStorage(id: string): Promise<Record<string, string>> {
    const s = this.sessions.get(id);
    if (!s) return {};
    try {
      const raw = await s.view.webContents.executeJavaScript(
        'JSON.stringify(Object.fromEntries(Object.entries(localStorage)))'
      );
      return JSON.parse(raw) ?? {};
    } catch { return {}; }
  }

  destroySession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (this.activeId === id) { this.win.contentView.removeChildView(s.view); this.activeId = null; }
    s.recorder.destroy();
    (s.view.webContents as any).destroy?.();
    this.sessions.delete(id);
    this.sessionNotes.delete(id);
  }
}
