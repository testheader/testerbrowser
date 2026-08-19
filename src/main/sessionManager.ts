import { BrowserWindow, BrowserView, session as electronSession } from 'electron';
import path from 'path';
import { app } from 'electron';
import { SessionRecorder } from './recorder';

export interface TestSession {
  id: string;
  name: string;
  persistent: boolean;
  partition: string;
  view: BrowserView;
  recorder: SessionRecorder;
  createdAt: number;
}

const TOP_BAR_HEIGHT = 88; // reserved space in the window for tabs + toolbar

export class SessionManager {
  private win: BrowserWindow;
  private sessions = new Map<string, TestSession>();
  private activeId: string | null = null;
  private dbDir: string;
  private consoleHeight = 220;
  private isViewVisible = true;

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
      createdAt: s.createdAt,
    }));
  }

  createSession(
    name: string,
    opts: { persistent?: boolean; startUrl?: string; partition?: string } = {}
  ): TestSession {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Caller can pass an existing partition to share cookies/storage with another session.
    const partition = opts.partition ?? (opts.persistent ? `persist:${id}` : id);
    const ses = electronSession.fromPartition(partition);

    const view = new BrowserView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        sandbox: true,
      },
    });

    const recorder = new SessionRecorder(view.webContents, {
      sessionId: id,
      dbDir: this.dbDir,
    });

    const testSession: TestSession = {
      id,
      name,
      persistent: !!opts.persistent || partition.startsWith('persist:'),
      partition,
      view,
      recorder,
      createdAt: Date.now(),
    };
    this.sessions.set(id, testSession);

    view.webContents.loadURL(opts.startUrl || 'https://example.com');

    view.webContents.on('did-navigate', (_e, url) => {
      this.win.webContents.send('session:navigated', { id, url });
    });
    view.webContents.on('did-navigate-in-page', (_e, url) => {
      this.win.webContents.send('session:navigated', { id, url });
    });
    view.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.control && input.key === 'Tab') {
        event.preventDefault();
        this.win.webContents.send('tabs:cycle', { reverse: input.shift });
      }
    });

    // Intercept window.open / target="_blank" — open as a new tab sharing this session's partition.
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

  renameSession(id: string, name: string) {
    const s = this.sessions.get(id);
    if (s) s.name = name.trim() || s.name;
  }

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
  }

  private layoutActive() {
    if (!this.activeId || !this.isViewVisible) return;
    const s = this.sessions.get(this.activeId);
    if (!s) return;
    const bounds = this.win.getContentBounds();
    s.view.setBounds({
      x: 0,
      y: TOP_BAR_HEIGHT,
      width: bounds.width,
      height: Math.max(0, bounds.height - TOP_BAR_HEIGHT - this.consoleHeight),
    });
    s.view.setAutoResize({ width: true, height: false });
  }

  setConsoleHeight(height: number) {
    this.consoleHeight = Math.max(80, Math.min(height, 600));
    this.layoutActive();
  }

  setViewerVisible(visible: boolean) {
    this.isViewVisible = visible;
    if (!this.activeId) return;
    const s = this.sessions.get(this.activeId);
    if (!s) return;
    if (visible) {
      this.win.addBrowserView(s.view);
      this.layoutActive();
    } else {
      this.win.removeBrowserView(s.view);
    }
  }

  /** Clone cookies/storage from one session into a newly created one. */
  async cloneSession(sourceId: string, newName: string): Promise<TestSession | null> {
    const src = this.sessions.get(sourceId);
    if (!src) return null;
    const dest = this.createSession(newName, { persistent: src.persistent });
    const cookies = await src.view.webContents.session.cookies.get({});
    for (const c of cookies) {
      const url = `${c.secure ? 'https' : 'http'}://${c.domain?.replace(/^\./, '')}${c.path}`;
      try {
        await dest.view.webContents.session.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate,
        });
      } catch {
        // best-effort; some cookies (e.g. host-only w/ __Host- prefix) are picky about url match
      }
    }
    return dest;
  }

  navigate(id: string, url: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    s.view.webContents.loadURL(normalized);
  }

  getTimeline(id: string, opts?: { limit?: number; since?: number }) {
    return this.sessions.get(id)?.recorder.getTimeline(opts) ?? [];
  }

  exportHAR(id: string) {
    return this.sessions.get(id)?.recorder.exportHAR() ?? null;
  }

  destroySession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (this.activeId === id) {
      this.win.removeBrowserView(s.view);
      this.activeId = null;
    }
    s.recorder.destroy();
    (s.view.webContents as any).destroy?.();
    this.sessions.delete(id);
  }
}
