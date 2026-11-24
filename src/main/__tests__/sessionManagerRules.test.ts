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
    destroyed = false;
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
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
    app: { getPath: jest.fn(() => '/tmp/tb-session-rules-test') },
    BrowserWindow: class {},
    WebContentsView: FakeWebContentsView,
    session: {
      fromPartition: jest.fn((partition: string) => {
        const ses = new EventEmitter();
        (ses as any).webRequest = { onCompleted: jest.fn() };
        (ses as any).setPermissionRequestHandler = jest.fn();
        (ses as any).setPermissionCheckHandler = jest.fn();
        (ses as any).cookies = { get: jest.fn(async () => (global as any).__jars?.[partition] ?? []) };
        return ses;
      }),
    },
    Menu: { buildFromTemplate: jest.fn(() => ({ popup: jest.fn() })) },
    clipboard: { writeText: jest.fn() },
    dialog: {},
  };
});

import { SessionManager } from '../sessionManager';
import type { RewriteAction } from '../rules';
import { makeMockRule, makeRule } from './ruleFactories';
import type { AppLog } from '../appLogger';
import type { EventEmitter } from 'events';

const noopLog: AppLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };

function makeManager(): SessionManager {
  const win = { on: jest.fn() } as unknown as BrowserWindow;
  return new SessionManager(win, () => false, noopLog);
}

type Dbg = EventEmitter & { sendCommand: jest.Mock };
const debuggerOf = (s: { view: unknown }) =>
  (s.view as { webContents: { debugger: Dbg } }).webContents.debugger;

function pause(dbg: Dbg, request: { url: string; method?: string; headers?: Record<string, string> }, requestId = 'req1') {
  dbg.emit('message', {}, 'Fetch.requestPaused', {
    requestId, networkId: `net-${requestId}`,
    request: { method: 'GET', headers: {}, ...request },
  });
}
const flush = () => new Promise((r) => setImmediate(r));
const commandsFor = (dbg: Dbg, name: string) => dbg.sendCommand.mock.calls.filter((c) => c[0] === name);
const lastContinue = (dbg: Dbg) => commandsFor(dbg, 'Fetch.continueRequest').pop()?.[1];

const COOKIE = (name: string, value: string, extra: object = {}) => ({ name, value, domain: 'app.test', path: '/', ...extra });

beforeEach(() => { (global as any).__jars = {}; });

describe('Fetch.requestPaused dispatch for rules (#370)', () => {
  it('a request no rule matches is continued untouched', () => {
    const sm = makeManager();
    const s = sm.createSession('A');
    sm.addRule(s.id, makeMockRule('m1', { urlPattern: 'https://api.test/*' }));
    const dbg = debuggerOf(s);
    dbg.sendCommand.mockClear();
    pause(dbg, { url: 'https://other.test/x' });
    expect(commandsFor(dbg, 'Fetch.continueRequest')).toEqual([['Fetch.continueRequest', { requestId: 'req1' }]]);
  });

  it('the first rule in the list wins, and reordering changes the winner', () => {
    const sm = makeManager();
    const s = sm.createSession('A');
    sm.addRule(s.id, makeMockRule('first', { statusCode: 201 }));
    sm.addRule(s.id, makeRule('second', { kind: 'fail', mode: 'error500' }));
    const dbg = debuggerOf(s);
    dbg.sendCommand.mockClear();
    pause(dbg, { url: 'https://x.test/a' });
    expect(commandsFor(dbg, 'Fetch.fulfillRequest')[0][1]).toMatchObject({ responseCode: 201 });

    sm.reorderRule(s.id, 'second', 0);
    dbg.sendCommand.mockClear();
    pause(dbg, { url: 'https://x.test/a' }, 'req2');
    expect(commandsFor(dbg, 'Fetch.fulfillRequest')[0][1]).toMatchObject({ responseCode: 500 });
  });

  it('a rule\'s delay holds the action back until it elapses', () => {
    jest.useFakeTimers();
    try {
      const sm = makeManager();
      const s = sm.createSession('A');
      sm.addRule(s.id, makeRule('slow', { kind: 'fail', mode: 'timeout' }, { delayMs: 3000 }));
      const dbg = debuggerOf(s);
      dbg.sendCommand.mockClear();
      pause(dbg, { url: 'https://x.test/a' });
      jest.advanceTimersByTime(2999);
      expect(commandsFor(dbg, 'Fetch.fulfillRequest')).toHaveLength(0);
      jest.advanceTimersByTime(1);
      expect(commandsFor(dbg, 'Fetch.fulfillRequest')[0][1]).toMatchObject({ responseCode: 504 });
    } finally { jest.useRealTimers(); }
  });

  it('a delay rule lets the request through unchanged after its delay', () => {
    jest.useFakeTimers();
    try {
      const sm = makeManager();
      const s = sm.createSession('A');
      sm.addRule(s.id, makeRule('lat', { kind: 'delay' }, { delayMs: 2000 }));
      const dbg = debuggerOf(s);
      dbg.sendCommand.mockClear();
      pause(dbg, { url: 'https://x.test/a' });
      expect(commandsFor(dbg, 'Fetch.continueRequest')).toHaveLength(0);
      jest.advanceTimersByTime(2000);
      expect(commandsFor(dbg, 'Fetch.continueRequest')).toEqual([['Fetch.continueRequest', { requestId: 'req1' }]]);
    } finally { jest.useRealTimers(); }
  });

  it('a hang with "fail after" fails the request with TimedOut, and without it never answers', () => {
    jest.useFakeTimers();
    try {
      const sm = makeManager();
      const s = sm.createSession('A');
      sm.addRule(s.id, makeRule('h', { kind: 'hang', failAfterMs: 5000 }));
      const dbg = debuggerOf(s);
      dbg.sendCommand.mockClear();
      pause(dbg, { url: 'https://x.test/a' });
      expect(dbg.sendCommand).not.toHaveBeenCalled();
      jest.advanceTimersByTime(5000);
      expect(commandsFor(dbg, 'Fetch.failRequest')[0][1]).toEqual({ requestId: 'req1', errorReason: 'TimedOut' });
    } finally { jest.useRealTimers(); }
  });
});

describe('Rewrite (#370)', () => {
  const rewrite = (over: Partial<RewriteAction> = {}): RewriteAction => ({ kind: 'rewrite', headers: {}, ...over });

  it('overrides headers, method, URL and body on Fetch.continueRequest and records what was sent', async () => {
    const sm = makeManager();
    const s = sm.createSession('A');
    const tag = jest.spyOn(s.recorder, 'tagRequest');
    sm.addRule(s.id, makeRule('rw', rewrite({ url: 'https://staging.test/v1', method: 'put', headers: { 'X-Test': '1', Authorization: '' }, body: '{"a":1}' })));
    const dbg = debuggerOf(s);
    dbg.sendCommand.mockClear();
    pause(dbg, { url: 'https://api.test/v1', method: 'POST', headers: { Authorization: 'Bearer a', Accept: '*/*', 'Content-Length': '2' } });
    await flush();

    const sent = lastContinue(dbg);
    expect(sent).toMatchObject({ requestId: 'req1', url: 'https://staging.test/v1', method: 'PUT', postData: Buffer.from('{"a":1}').toString('base64') });
    const names = sent.headers.map((h: { name: string }) => h.name.toLowerCase());
    expect(names).toEqual(expect.arrayContaining(['accept', 'x-test']));
    expect(names).not.toContain('authorization');
    expect(names).not.toContain('content-length');
    expect(tag).toHaveBeenLastCalledWith('net-req1', expect.objectContaining({
      ruleId: 'rw', ruleKind: 'rewrite',
      sent: expect.objectContaining({ url: 'https://staging.test/v1', method: 'PUT', body: '{"a":1}' }),
    }));
  });

  it('sends the cookies of another open session, read live at request time, with extras on top', async () => {
    const sm = makeManager();
    const source = sm.createSession('Admin', { partition: 'persist:admin', persistent: true });
    const tab = sm.createSession('Tester', { partition: 'persist:tester', persistent: true });
    (global as any).__jars['persist:admin'] = [COOKIE('sid', 'admin-1'), COOKIE('theme', 'dark')];
    sm.addRule(tab.id, makeRule('rw', rewrite({ cookies: { sourcePartition: 'persist:admin', extra: { theme: 'light', flag: 'on' } } })));
    const dbg = debuggerOf(tab);
    dbg.sendCommand.mockClear();

    pause(dbg, { url: 'https://app.test/api', headers: { Cookie: 'sid=tester-own' } });
    await flush();
    const cookieOf = (call: { headers: { name: string; value: string }[] }) => call.headers.find(h => h.name.toLowerCase() === 'cookie')?.value;
    expect(cookieOf(lastContinue(dbg))).toBe('sid=admin-1; theme=light; flag=on');

    // Live: the source's jar changed, the next request sees it.
    (global as any).__jars['persist:admin'] = [COOKIE('sid', 'admin-2')];
    pause(dbg, { url: 'https://app.test/api' }, 'req2');
    await flush();
    expect(cookieOf(lastContinue(dbg))).toBe('sid=admin-2; theme=light; flag=on');
    void source;
  });

  it('keeps using the source\'s last cookies after its last tab is closed', async () => {
    const sm = makeManager();
    const source = sm.createSession('Admin', { partition: 'persist:admin', persistent: true });
    const tab = sm.createSession('Tester', { partition: 'persist:tester', persistent: true });
    (global as any).__jars['persist:admin'] = [COOKIE('sid', 'last-state')];
    sm.addRule(tab.id, makeRule('rw', rewrite({ cookies: { sourcePartition: 'persist:admin', extra: {} } })));

    sm.destroySession(source.id);
    await flush();
    // The closed session's jar is gone now — only the snapshot is left.
    (global as any).__jars['persist:admin'] = [];

    const dbg = debuggerOf(tab);
    dbg.sendCommand.mockClear();
    pause(dbg, { url: 'https://app.test/api' });
    await flush();
    expect(lastContinue(dbg).headers).toContainEqual({ name: 'Cookie', value: 'sid=last-state' });
    // The renderer is told how many cookies are kept, never handed the jar itself.
    const [rule] = sm.getRules(tab.id);
    expect((rule.action as RewriteAction).cookies?.snapshot).toHaveLength(1);
  });

  it('a source session with no cookies for the URL sends none — it never falls back to the tab\'s own cookies', async () => {
    const sm = makeManager();
    sm.createSession('Empty', { partition: 'persist:empty', persistent: true });
    const tab = sm.createSession('Tester', { partition: 'persist:tester', persistent: true });
    (global as any).__jars['persist:empty'] = [COOKIE('other', 'x', { domain: 'elsewhere.test' })];
    sm.addRule(tab.id, makeRule('rw', rewrite({ cookies: { sourcePartition: 'persist:empty', extra: {} } })));
    const dbg = debuggerOf(tab);
    dbg.sendCommand.mockClear();
    pause(dbg, { url: 'https://app.test/api', headers: { Cookie: 'sid=tester-own' } });
    await flush();
    expect(lastContinue(dbg).headers).toContainEqual({ name: 'Cookie', value: '' });
  });

  it('never writes a cookie snapshot to the persisted rules', async () => {
    const sm = makeManager();
    const source = sm.createSession('Admin', { partition: 'persist:admin', persistent: true });
    const tab = sm.createSession('Tester', { partition: 'persist:tester', persistent: true });
    (global as any).__jars['persist:admin'] = [COOKIE('sid', 'secret')];
    sm.addRule(tab.id, makeRule('rw', rewrite({ cookies: { sourcePartition: 'persist:admin', extra: {} } })));
    pause(debuggerOf(tab), { url: 'https://app.test/api' });
    await flush();
    expect((sm.getRules(tab.id)[0].action as RewriteAction).cookies?.snapshot).toBeDefined();

    const saved = JSON.stringify(sm.collectSaveState().rules);
    expect(saved).toContain('persist:admin');
    expect(saved).not.toContain('secret');
    void source;
  });

  it('falls back to sending the request unchanged if building the rewrite fails', async () => {
    const sm = makeManager();
    const s = sm.createSession('A');
    sm.addRule(s.id, makeRule('rw', rewrite({ cookies: { sourcePartition: 'persist:gone', extra: {} } })));
    const dbg = debuggerOf(s);
    // A jar that cannot be read must not leave the request paused forever.
    const { session } = jest.requireMock('electron');
    session.fromPartition.mockImplementationOnce(() => { throw new Error('boom'); });
    (sm as any).shared.partitionRefs.set('persist:gone', 1);
    dbg.sendCommand.mockClear();
    pause(dbg, { url: 'https://app.test/api' });
    await flush();
    expect(commandsFor(dbg, 'Fetch.continueRequest')).toEqual([['Fetch.continueRequest', { requestId: 'req1' }]]);
  });
});
