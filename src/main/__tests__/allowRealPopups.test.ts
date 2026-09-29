import type { BrowserWindow } from 'electron';

// better-sqlite3 is compiled against Electron's ABI via electron-rebuild,
// incompatible with Jest's Node runtime (see recorder.test.ts) — mock it
// minimally since these tests only need SessionRecorder's constructor to not
// throw, not its actual behavior.
jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    pragma: jest.fn(),
    exec: jest.fn(),
    prepare: jest.fn(() => ({ run: jest.fn(), get: jest.fn(), all: jest.fn(() => []) })),
    close: jest.fn(),
  }));
});

// createSession() needs a real-enough WebContentsView/session/debugger
// surface to run end to end (same reasoning as sessionManagerLogging.test.ts,
// which this mock is adapted from) — the point of these tests is
// setWindowOpenHandler()'s own callback, registered inside createSession(),
// so it has to actually run here rather than being bypassed with a fake
// TestSession the way most other sessionManager.ts tests do it. Unlike that
// file's version, setWindowOpenHandler() here *captures* the handler instead
// of being a no-op, so tests can invoke it directly.
let capturedHandler: ((details: { url: string }) => unknown) | undefined;
let fromPartitionSessions: Record<string, unknown> = {};

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
    setWindowOpenHandler(handler: (details: { url: string }) => unknown) { capturedHandler = handler; }
    loadFile() {}
    loadURL() {}
    canGoBack() { return false; }
    canGoForward() { return false; }
    getZoomFactor() { return 1; }
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents();
    setBounds() {}
  }

  return {
    app: { getPath: jest.fn(() => '/tmp/tb-allow-real-popups-test') },
    BrowserWindow: class {},
    WebContentsView: FakeWebContentsView,
    session: {
      fromPartition: jest.fn((partition: string) => {
        const ses = new EventEmitter();
        (ses as any).webRequest = { onCompleted: jest.fn() };
        (ses as any).setPermissionRequestHandler = jest.fn();
        (ses as any).setPermissionCheckHandler = jest.fn();
        (ses as any).cookies = { get: jest.fn().mockResolvedValue([]) };
        fromPartitionSessions[partition] = ses;
        return ses;
      }),
    },
    Menu: { buildFromTemplate: jest.fn(() => ({ popup: jest.fn() })) },
    clipboard: { writeText: jest.fn() },
    dialog: {},
  };
});

import { SessionManager } from '../sessionManager';

// The default-off test below exercises the real deny-and-recreate path,
// whose setImmediate() callback calls switchTo() (win.contentView.
// addChildView) and sendNavState/onSessionsChanged (win.webContents.send) —
// unlike sessionManagerLogging.test.ts's makeManager(), this needs those
// mocked too, or that callback throws asynchronously and crashes the whole
// Jest process (it's an uncaught exception outside the test's own control).
function makeManager(getAllowRealPopups: () => boolean): SessionManager {
  const win = {
    on: jest.fn(),
    contentView: { addChildView: jest.fn(), removeChildView: jest.fn() },
    getContentBounds: jest.fn(() => ({ width: 800, height: 600 })),
    webContents: { send: jest.fn() },
  } as unknown as BrowserWindow;
  return new SessionManager(win, () => false, undefined, undefined, undefined, getAllowRealPopups);
}

describe('setWindowOpenHandler — allowRealPopups (#270)', () => {
  beforeEach(() => {
    capturedHandler = undefined;
    fromPartitionSessions = {};
  });

  it('denies and recreates as a tracked tab by default (byte-for-byte the pre-#270 behaviour)', () => {
    const sm = makeManager(() => false);
    sm.createSession('Test');

    expect(capturedHandler).toBeDefined();
    const response = capturedHandler!({ url: 'https://example.com/oauth' });
    expect(response).toEqual({ action: 'deny' });
  });

  it('allows and shares the opener\'s session/partition when the setting is on', () => {
    const sm = makeManager(() => true);
    const session = sm.createSession('Test');

    expect(capturedHandler).toBeDefined();
    const response = capturedHandler!({ url: 'https://example.com/oauth' }) as {
      action: string;
      overrideBrowserWindowOptions?: { webPreferences?: { session?: unknown } };
    };
    expect(response.action).toBe('allow');
    expect(response.overrideBrowserWindowOptions?.webPreferences?.session)
      .toBe(fromPartitionSessions[session.partition]);
  });

  it('denies an unsafe URL regardless of the setting', () => {
    const sm = makeManager(() => true);
    sm.createSession('Test');

    expect(capturedHandler).toBeDefined();
    expect(capturedHandler!({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    expect(capturedHandler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
  });
});
