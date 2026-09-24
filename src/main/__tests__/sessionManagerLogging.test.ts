import type { BrowserWindow } from 'electron';

// better-sqlite3 is compiled against Electron's ABI via electron-rebuild,
// incompatible with Jest's Node runtime (see recorder.test.ts/
// debugLogStore.test.ts) — mock it minimally since these tests only need
// SessionRecorder's constructor to not throw, not its actual behavior.
jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    pragma: jest.fn(),
    exec: jest.fn(),
    prepare: jest.fn(() => ({ run: jest.fn(), get: jest.fn(), all: jest.fn(() => []) })),
    close: jest.fn(),
  }));
});

// createSession()/destroySession() need a real-enough WebContentsView,
// session and debugger surface to run end to end — every other
// sessionManager.ts test file bypasses createSession() with its own
// installFakeSession() helper (it needs a real WebContentsView), but that's
// exactly the code these tests are about, so it has to actually run here.
// Self-contained (own require('events'), no outer-scope references) so
// nothing runs into jest.mock()'s hoisting-above-imports behavior.
jest.mock('electron', () => {
  const { EventEmitter } = require('events');

  class FakeWebContents extends EventEmitter {
    id = Math.floor(Math.random() * 1e6);
    debugger: any;
    constructor() {
      super();
      this.debugger = new EventEmitter();
      this.debugger.sendCommand = jest.fn().mockResolvedValue({});
    }
    getUserAgent() { return 'fake-ua'; }
    setUserAgent() {}
    setWindowOpenHandler() {}
    loadFile() {}
    loadURL() {}
    canGoBack() { return false; }
    canGoForward() { return false; }
    getZoomFactor() { return 1; }
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents();
  }

  return {
    app: { getPath: jest.fn(() => '/tmp/tb-session-logging-test') },
    BrowserWindow: class {},
    WebContentsView: FakeWebContentsView,
    session: {
      fromPartition: jest.fn(() => {
        const ses = new EventEmitter();
        (ses as any).webRequest = { onCompleted: jest.fn() };
        (ses as any).setPermissionRequestHandler = jest.fn();
        (ses as any).setPermissionCheckHandler = jest.fn();
        (ses as any).cookies = { get: jest.fn().mockResolvedValue([]) };
        return ses;
      }),
    },
    Menu: { buildFromTemplate: jest.fn(() => ({ popup: jest.fn() })) },
    clipboard: { writeText: jest.fn() },
    dialog: {},
  };
});

import { SessionManager } from '../sessionManager';
import type { AppLog } from '../appLogger';

interface LoggedCall { level: string; source: string; message: string; ctx?: Record<string, unknown>; }

function makeLogger(): AppLog & { calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  const record = (level: string) => (source: string, message: string, ctx?: Record<string, unknown>) => {
    calls.push({ level, source, message, ctx });
  };
  return {
    error: jest.fn(record('error')),
    warn: jest.fn(record('warn')),
    info: jest.fn(record('info')),
    debug: jest.fn(record('debug')),
    calls,
  };
}

function makeManager(logger: AppLog): SessionManager {
  const win = { on: jest.fn() } as unknown as BrowserWindow;
  return new SessionManager(win, () => false, logger);
}

describe('SessionManager logging (#227)', () => {
  it('creating then destroying a session produces exactly 2 info lines from source "sessions"', () => {
    const logger = makeLogger();
    const sm = makeManager(logger);

    const session = sm.createSession('Test');
    sm.destroySession(session.id);

    const sessionsInfo = logger.calls.filter((c) => c.level === 'info' && c.source === 'sessions');
    expect(sessionsInfo).toHaveLength(2);
    expect(sessionsInfo[0].message).toBe('Session created');
    expect(sessionsInfo[1].message).toBe('Session destroyed');
    expect(sessionsInfo[0].ctx).toEqual({ sessionId: session.id });
    expect(sessionsInfo[1].ctx).toEqual({ sessionId: session.id });
  });

  it('a rejected Fetch.enable produces one warn line naming Fetch.enable and the session id', async () => {
    const logger = makeLogger();
    const sm = makeManager(logger);
    const session = sm.createSession('Test');

    const dbg = (session.view as unknown as { webContents: { debugger: { sendCommand: jest.Mock } } })
      .webContents.debugger;
    dbg.sendCommand = jest.fn().mockRejectedValue(new Error('boom'));

    sm.addMockRule(session.id, {
      id: 'm1', urlPattern: '*', method: '*', statusCode: 200, body: '',
      responseHeaders: {}, enabled: true, hitCount: 0, lastHitAt: null,
    });

    // _applyFetch()'s Fetch.enable call is fire-and-forget (not awaited by
    // addMockRule) — flush the microtask queue so its rejection's .catch()
    // handler has run before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    const fetchEnableWarnings = logger.calls.filter(
      (c) => c.level === 'warn' && c.message.includes('Fetch.enable')
    );
    expect(fetchEnableWarnings).toHaveLength(1);
    expect(fetchEnableWarnings[0].ctx).toMatchObject({ sessionId: session.id });
  });
});
