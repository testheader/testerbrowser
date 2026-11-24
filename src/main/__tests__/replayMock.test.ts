import type { BrowserWindow } from 'electron';

// Same minimal mocks as sessionManagerLogging.test.ts — createSession()/
// addRule() need a real-enough WebContentsView, session and debugger
// surface to run end to end.
jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    pragma: jest.fn(),
    exec: jest.fn(),
    prepare: jest.fn(() => ({ run: jest.fn(), get: jest.fn(), all: jest.fn(() => []) })),
    close: jest.fn(),
  }));
});

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
    app: { getPath: jest.fn(() => '/tmp/tb-replay-mock-test') },
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
import type { Rule } from '../rules';
import { makeMockRule } from './ruleFactories';

function makeManager(): SessionManager {
  const win = { on: jest.fn() } as unknown as BrowserWindow;
  return new SessionManager(win, () => false);
}

function makeRule(overrides: Parameters<typeof makeMockRule>[1] & { id?: string } = {}): Rule {
  const { id = 'r1', ...rest } = overrides;
  return makeMockRule(id, { urlPattern: '*/api/*', body: '{"ok":true}', ...rest });
}

describe('findMatchingRule (#233)', () => {
  it('returns the enabled rule matching method and URL', () => {
    const sm = makeManager();
    const session = sm.createSession('Test');
    sm.addRule(session.id, makeRule({ id: 'r1', method: 'GET', urlPattern: '*/api/*' }));

    const found = sm.findMatchingRule(session.id, 'GET', 'https://example.com/api/data');
    expect(found?.id).toBe('r1');
  });

  it('ignores a disabled rule', () => {
    const sm = makeManager();
    const session = sm.createSession('Test');
    sm.addRule(session.id, makeRule({ id: 'r1', enabled: false, urlPattern: '*/api/*' }));

    expect(sm.findMatchingRule(session.id, 'GET', 'https://example.com/api/data')).toBeNull();
  });

  it('respects the method field', () => {
    const sm = makeManager();
    const session = sm.createSession('Test');
    sm.addRule(session.id, makeRule({ id: 'r1', method: 'POST', urlPattern: '*/api/*' }));

    expect(sm.findMatchingRule(session.id, 'GET', 'https://example.com/api/data')).toBeNull();
    expect(sm.findMatchingRule(session.id, 'POST', 'https://example.com/api/data')?.id).toBe('r1');
  });

  it('a "*" method matches any request method', () => {
    const sm = makeManager();
    const session = sm.createSession('Test');
    sm.addRule(session.id, makeRule({ id: 'r1', method: '*', urlPattern: '*/api/*' }));

    expect(sm.findMatchingRule(session.id, 'DELETE', 'https://example.com/api/data')?.id).toBe('r1');
  });

  it('returns null when no rule matches the URL', () => {
    const sm = makeManager();
    const session = sm.createSession('Test');
    sm.addRule(session.id, makeRule({ id: 'r1', urlPattern: '*/api/*' }));

    expect(sm.findMatchingRule(session.id, 'GET', 'https://example.com/other')).toBeNull();
  });

  it('returns null for an unknown session id', () => {
    const sm = makeManager();
    expect(sm.findMatchingRule('nonexistent', 'GET', 'https://example.com/api/data')).toBeNull();
  });
});

describe('getPartition (#233)', () => {
  it("returns the session's partition", () => {
    const sm = makeManager();
    const session = sm.createSession('Test', { persistent: true });
    expect(sm.getPartition(session.id)).toBe(session.partition);
  });

  it('returns null for an unknown session id', () => {
    const sm = makeManager();
    expect(sm.getPartition('nonexistent')).toBeNull();
  });
});
