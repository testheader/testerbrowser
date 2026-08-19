import { BrowserWindow, BrowserView, session as electronSession, Menu } from 'electron';
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
  view: BrowserView;
  recorder: SessionRecorder;
  createdAt: number;
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
      createdAt: s.createdAt,
    }));
  }

  createSession(
    name: string,
    opts: { persistent?: boolean; startUrl?: string; partition?: string } = {}
  ): TestSession {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partition = opts.partition ?? (opts.persistent ? `persist:${id}` : id);
    const ses = electronSession.fromPartition(partition);

    const view = new BrowserView({
      webPreferences: { session: ses, contextIsolation: true, sandbox: true },
    });

    const recorder = new SessionRecorder(view.webContents, { sessionId: id, dbDir: this.dbDir });

    const testSession: TestSession = {
      id, name,
      persistent: !!opts.persistent || partition.startsWith('persist:'),
      partition,
      currentUrl: opts.startUrl || 'https://example.com',
      pinned: false,
      view, recorder,
      createdAt: Date.now(),
    };
    this.sessions.set(id, testSession);

    view.webContents.loadURL(opts.startUrl || 'https://example.com');

    view.webContents.on('did-navigate', (_e, url) => {
      testSession.currentUrl = url;
      this.win.webContents.send('session:navigated', { id, url });
      this.sendNavState(id);
    });
    view.webContents.on('did-navigate-in-page', (_e, url) => {
      testSession.currentUrl = url;
      this.win.webContents.send('session:navigated', { id, url });
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

    view.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const { control: ctrl, shift, alt, key } = input;
      const send = (name: string) => { event.preventDefault(); this.win.webContents.send('app:shortcut', name); };

      if (ctrl && key === 'Tab')   { event.preventDefault(); this.win.webContents.send('tabs:cycle', { reverse: shift }); return; }
      if (ctrl && !shift && key === 't') { send('newTab'); return; }
      if (ctrl && !shift && key === 'w') { send('closeTab'); return; }
      if (ctrl && shift && key === 'T')  { send('reopenTab'); return; }
      if (ctrl && key === 'l')           { send('focusUrl'); return; }
      if (ctrl && key === 'f')           { send('findToggle'); return; }
      if (key === 'F3')  { send(shift ? 'findPrev' : 'findNext'); return; }
      if ((ctrl && key === 'r') || key === 'F5') { send('reload'); return; }
      if (key === 'F12') { event.preventDefault(); this.toggleDevTools(this.activeId ?? ''); return; }
      if (ctrl && (key === '=' || key === '+')) { event.preventDefault(); this.setZoom(this.activeId ?? '', 0.1); return; }
      if (ctrl && key === '-')  { event.preventDefault(); this.setZoom(this.activeId ?? '', -0.1); return; }
      if (ctrl && key === '0')  { event.preventDefault(); this.resetZoom(this.activeId ?? ''); return; }
      if (alt && key === 'ArrowLeft')  { event.preventDefault(); this.back(this.activeId ?? ''); return; }
      if (alt && key === 'ArrowRight') { event.preventDefault(); this.forward(this.activeId ?? ''); return; }
    });

    view.webContents.setWindowOpenHandler(({ url }) => {
      setImmediate(() => {
        const tabName = (() => { try { return new URL(url).hostname || 'New tab'; } catch { return 'New tab'; } })();
        const newSession = this.createSession(tabName, { partition, startUrl: url });
        this.switchTo(newSession.id);
        this.win.webContents.send('session:newTab', { id: newSession.id });
      });
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

  renameSession(id: string, name: string) {
    const s = this.sessions.get(id);
    if (s) s.name = name.trim() || s.name;
  }

  pinSession(id: string, pinned: boolean) {
    const s = this.sessions.get(id);
    if (s) s.pinned = pinned;
  }

  back(id: string)   { this.sessions.get(id)?.view.webContents.goBack(); }
  forward(id: string){ this.sessions.get(id)?.view.webContents.goForward(); }
  reload(id: string) { this.sessions.get(id)?.view.webContents.reload(); }

  setZoom(id: string, delta: number) {
    const s = this.sessions.get(id);
    if (!s) return;
    const cur = s.view.webContents.getZoomFactor();
    s.view.webContents.setZoomFactor(Math.max(0.25, Math.min(5, Math.round((cur + delta) * 10) / 10)));
  }
  resetZoom(id: string) { this.sessions.get(id)?.view.webContents.setZoomFactor(1); }

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
      if (prev) this.win.removeBrowserView(prev.view);
    }
    this.activeId = id;
    if (this.isViewVisible) {
      this.win.addBrowserView(s.view);
      this.layoutActive();
    }
    this.sendNavState(id);
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
    s.view.setAutoResize({ width: true, height: false });
  }

  setConsoleHeight(height: number) {
    this.consoleHeight = Math.max(80, Math.min(height, 600));
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
    if (visible) { this.win.addBrowserView(s.view); this.layoutActive(); }
    else { this.win.removeBrowserView(s.view); }
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

  destroySession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (this.activeId === id) { this.win.removeBrowserView(s.view); this.activeId = null; }
    s.recorder.destroy();
    (s.view.webContents as any).destroy?.();
    this.sessions.delete(id);
    this.sessionNotes.delete(id);
  }
}
