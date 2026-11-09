import type { BrowserWindow } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Same minimal mocks as sessionPinPersistence.test.ts — createSession()/
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
import type { MockRule } from '../mockManager';

function makeManager(): SessionManager {
  // loadAndRestoreSessions() ends by calling switchTo() on the first restored
  // session, which unconditionally touches win.contentView and win.webContents.
  const win = {
    on: jest.fn(),
    contentView: { addChildView: jest.fn(), removeChildView: jest.fn() },
    webContents: { send: jest.fn() },
    getContentBounds: jest.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
  } as unknown as BrowserWindow;
  return new SessionManager(win, () => false);
}


import { buildSessionsFile, parseSessionsFile } from '../sessionPersistence';
import { createSharedPartitionState } from '../partitionState';

function makeRule(id: string): MockRule {
  return {
    id, urlPattern: '*/api/*', method: '*', statusCode: 200, body: '{}',
    responseHeaders: {}, enabled: true, hitCount: 0, lastHitAt: null,
  };
}

function makeWindowManager(shared = createSharedPartitionState()): SessionManager {
  const win = {
    on: jest.fn(),
    contentView: { addChildView: jest.fn(), removeChildView: jest.fn() },
    webContents: { send: jest.fn() },
    getContentBounds: jest.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
  } as unknown as BrowserWindow;
  return new SessionManager(win, () => false, undefined, undefined, undefined, undefined, shared);
}

describe('multi-window persistence (#367)', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-multiwin-'));
    (global as any).__tbUserDataDir = userDataDir;
  });
  afterEach(() => { fs.rmSync(userDataDir, { recursive: true, force: true }); });

  it('two windows sharing a partition share its mock rules', () => {
    const shared = createSharedPartitionState();
    const a = makeWindowManager(shared);
    const b = makeWindowManager(shared);
    const sa = a.createSession('A', { persistent: true });
    const sb = b.createSession('B', { persistent: true, partition: sa.partition });
    a.addMockRule(sa.id, makeRule('m1'));
    expect(b.getMockRules(sb.id).map((r) => r.id)).toEqual(['m1']);
  });

  it('without shared state, windows keep separate rule sets', () => {
    const a = makeWindowManager();
    const b = makeWindowManager();
    const sa = a.createSession('A', { persistent: true });
    const sb = b.createSession('B', { persistent: true, partition: sa.partition });
    a.addMockRule(sa.id, makeRule('m1'));
    expect(b.getMockRules(sb.id)).toEqual([]);
  });

  it('two windows save into one file and restore into two windows', () => {
    const shared = createSharedPartitionState();
    const a = makeWindowManager(shared);
    const b = makeWindowManager(shared);
    const a1 = a.createSession('A1', { persistent: true, startUrl: 'https://a.test/' });
    const b1 = b.createSession('B1', { persistent: true, startUrl: 'https://b.test/' });
    a.setNotes(a1.id, 'note for a1');
    b.addMockRule(b1.id, makeRule('m1'));

    fs.writeFileSync(path.join(userDataDir, 'open-sessions.json'),
      JSON.stringify(buildSessionsFile([a.collectSaveState(), b.collectSaveState()])));

    const file = parseSessionsFile(JSON.parse(fs.readFileSync(path.join(userDataDir, 'open-sessions.json'), 'utf-8')));
    expect(file.windows).toHaveLength(2);

    const sharedAfter = createSharedPartitionState();
    const c = makeWindowManager(sharedAfter);
    const d = makeWindowManager(sharedAfter);
    expect(c.restoreWindow(file.windows[0].sessions, file)).toBe(true);
    expect(d.restoreWindow(file.windows[1].sessions, file)).toBe(true);

    expect(c.listSessions().map((s) => s.name)).toEqual(['A1']);
    expect(d.listSessions().map((s) => s.name)).toEqual(['B1']);
    expect(c.getNotes(c.listSessions()[0].id)).toBe('note for a1');
    expect(d.getMockRules(d.listSessions()[0].id).map((r) => r.id)).toEqual(['m1']);
  });

  it('a file written by the single-window version restores into one window', () => {
    const legacy = {
      sessions: [{ id: 'old1', name: 'Old', partition: 'persist:old', url: 'https://old.test/', color: '#fff', pinned: true }],
      notes: { old1: 'kept' }, emulation: {}, mocks: {},
    };
    fs.writeFileSync(path.join(userDataDir, 'open-sessions.json'), JSON.stringify(legacy));
    const sm = makeWindowManager();
    expect(sm.loadAndRestoreSessions()).toBe(true);
    const [s] = sm.listSessions();
    expect(s).toMatchObject({ id: 'old1', name: 'Old' });
    expect(sm.getNotes('old1')).toBe('kept');
  });

  it('saves go through saveAll when set, so one window cannot overwrite the others', () => {
    const sm = makeWindowManager();
    const saveAll = jest.fn();
    sm.saveAll = saveAll;
    const s = sm.createSession('T', { persistent: true });
    sm.addMockRule(s.id, makeRule('m1'));
    expect(saveAll).toHaveBeenCalled();
    expect(fs.existsSync(path.join(userDataDir, 'open-sessions.json'))).toBe(false);
  });
});
