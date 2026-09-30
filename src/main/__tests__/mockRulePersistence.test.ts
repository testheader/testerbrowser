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

function makeMockRule(id: string, overrides: Partial<MockRule> = {}): MockRule {
  return {
    id, urlPattern: '*/api/*', method: '*', statusCode: 200, body: '{}',
    responseHeaders: {}, enabled: true, hitCount: 0, lastHitAt: null,
    ...overrides,
  };
}

describe('Mock rules persist with persistent sessions (#264)', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mock-persist-'));
    (global as any).__tbUserDataDir = userDataDir;
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('addMockRule() on a persistent session saves it to disk with hitCount/lastHitAt reset', () => {
    const sm = makeManager();
    const session = sm.createSession('Test', { persistent: true });
    sm.addMockRule(session.id, makeMockRule('m1', { hitCount: 7, lastHitAt: 1700000000000 }));

    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'open-sessions.json'), 'utf-8'));
    expect(saved.mocks[session.partition]).toHaveLength(1);
    expect(saved.mocks[session.partition][0]).toMatchObject({ id: 'm1', hitCount: 0, lastHitAt: null });
  });

  it('a temp (non-persistent) session\'s mock rules are never saved', () => {
    const sm = makeManager();
    const session = sm.createSession('Temp', { persistent: false });
    sm.addMockRule(session.id, makeMockRule('m1'));

    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'open-sessions.json'), 'utf-8'));
    expect(saved.mocks?.[session.partition]).toBeUndefined();
  });

  it('loadAndRestoreSessions() restores a persistent session\'s mock rules into a fresh SessionManager', () => {
    const sm1 = makeManager();
    const session = sm1.createSession('Test', { persistent: true });
    sm1.addMockRule(session.id, makeMockRule('m1', { urlPattern: '*/widgets/*', statusCode: 201 }));

    const sm2 = makeManager();
    const restored = sm2.loadAndRestoreSessions();
    expect(restored).toBe(true);

    const [restoredSession] = sm2.listSessions();
    const rules = sm2.getMockRules(restoredSession.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: 'm1', urlPattern: '*/widgets/*', statusCode: 201, hitCount: 0, lastHitAt: null });
  });

  it('a restored rule is live: findMatchingMockRule sees it without any further setup', () => {
    const sm1 = makeManager();
    const session = sm1.createSession('Test', { persistent: true });
    sm1.addMockRule(session.id, makeMockRule('m1', { urlPattern: 'https://api.example.com/*' }));

    const sm2 = makeManager();
    sm2.loadAndRestoreSessions();
    const [restoredSession] = sm2.listSessions();

    const match = sm2.findMatchingMockRule(restoredSession.id, 'GET', 'https://api.example.com/widgets');
    expect(match?.id).toBe('m1');
  });

  it('a session with no saved mock rules restores cleanly with an empty rule list', () => {
    const sm1 = makeManager();
    sm1.createSession('Test', { persistent: true });
    // Nothing mutated any mock rules, so nothing triggered a save yet —
    // simulate the quit-time save every persistent session already gets.
    sm1.saveSessions();

    const sm2 = makeManager();
    sm2.loadAndRestoreSessions();
    const [restoredSession] = sm2.listSessions();

    expect(sm2.getMockRules(restoredSession.id)).toEqual([]);
  });

  it('update/toggle/remove/move all persist the change', () => {
    const sm = makeManager();
    const session = sm.createSession('Test', { persistent: true });
    sm.addMockRule(session.id, makeMockRule('m1'));
    sm.addMockRule(session.id, makeMockRule('m2'));

    const readSaved = () => JSON.parse(fs.readFileSync(path.join(userDataDir, 'open-sessions.json'), 'utf-8'));

    sm.updateMockRule(session.id, 'm1', { statusCode: 503 });
    expect(readSaved().mocks[session.partition].find((r: MockRule) => r.id === 'm1').statusCode).toBe(503);

    sm.toggleMockRule(session.id, 'm1', false);
    expect(readSaved().mocks[session.partition].find((r: MockRule) => r.id === 'm1').enabled).toBe(false);

    sm.moveMockRule(session.id, 'm2', 'up');
    expect(readSaved().mocks[session.partition].map((r: MockRule) => r.id)).toEqual(['m2', 'm1']);

    sm.removeMockRule(session.id, 'm1');
    expect(readSaved().mocks[session.partition].map((r: MockRule) => r.id)).toEqual(['m2']);
  });
});
