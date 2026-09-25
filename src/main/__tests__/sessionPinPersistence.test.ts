import type { BrowserWindow } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Same minimal mocks as sessionManagerLogging.test.ts — createSession()/
// saveSessions()/loadAndRestoreSessions() need a real-enough WebContentsView,
// session and debugger surface to run end to end.
jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    pragma: jest.fn(),
    exec: jest.fn(),
    prepare: jest.fn(() => ({ run: jest.fn(), get: jest.fn(), all: jest.fn(() => []) })),
    close: jest.fn(),
  }));
});

let userDataDir: string;

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
    setBounds() {}
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app: { getPath: jest.fn(() => (global as any).__tbUserDataDir) },
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

function makeManager(): SessionManager {
  // loadAndRestoreSessions() ends by calling switchTo() on the first restored
  // session, which unconditionally touches win.contentView and win.webContents
  // — a bare `{ on: jest.fn() }` (fine for createSession()/destroySession()
  // alone, as in sessionManagerLogging.test.ts) throws there.
  const win = {
    on: jest.fn(),
    contentView: { addChildView: jest.fn(), removeChildView: jest.fn() },
    webContents: { send: jest.fn() },
    getContentBounds: jest.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
  } as unknown as BrowserWindow;
  return new SessionManager(win, () => false);
}

describe('Pinned tabs survive save/restore (#231)', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-pin-persist-'));
    (global as any).__tbUserDataDir = userDataDir;
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('a pinned persistent session is still pinned after saveSessions()+loadAndRestoreSessions()', () => {
    const sm1 = makeManager();
    const session = sm1.createSession('Test', { persistent: true });
    sm1.pinSession(session.id, true);
    sm1.saveSessions();

    const sm2 = makeManager();
    const restored = sm2.loadAndRestoreSessions();
    expect(restored).toBe(true);

    const [restoredSession] = sm2.listSessions();
    expect(restoredSession.pinned).toBe(true);
  });

  it('an unpinned persistent session stays unpinned after save/restore', () => {
    const sm1 = makeManager();
    sm1.createSession('Test', { persistent: true });
    sm1.saveSessions();

    const sm2 = makeManager();
    sm2.loadAndRestoreSessions();

    const [restoredSession] = sm2.listSessions();
    expect(restoredSession.pinned).toBe(false);
  });
});
