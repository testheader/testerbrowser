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
    app: { getPath: jest.fn(() => '/tmp/tb-race-gate-test') },
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
import type { EventEmitter } from 'events';

const NOOP_LOG: AppLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };

type Dbg = EventEmitter & { sendCommand: jest.Mock };

// Tests that leave requests parked would otherwise keep a real gate timer alive.
const managers: SessionManager[] = [];

function makeManager(): SessionManager {
  const sm = makeManagerRaw();
  managers.push(sm);
  return sm;
}

function makeManagerRaw(): SessionManager {
  return new SessionManager({ on: jest.fn() } as unknown as import('electron').BrowserWindow, () => false, NOOP_LOG);
}

function dbgOf(session: { view: unknown }): Dbg {
  return (session.view as { webContents: { debugger: Dbg } }).webContents.debugger;
}

function raceRule(over: Record<string, unknown> = {}) {
  return {
    id: 'race1', type: 'race' as const, urlPattern: '*/redeem*', method: 'POST', probability: 1,
    latencyMs: 0, holdCount: 3, releaseAfterMs: 5000, enabled: true, hitCount: 0, lastHitAt: null, ...over,
  };
}

function pause(dbg: Dbg, requestId: string, url = 'https://shop.test/redeem?c=1', method = 'POST'): void {
  dbg.emit('message', {}, 'Fetch.requestPaused', { requestId, request: { url, method } });
}

/** requestIds that were answered with Fetch.continueRequest, in order. */
function continued(dbg: Dbg): string[] {
  return dbg.sendCommand.mock.calls
    .filter(([cmd]) => cmd === 'Fetch.continueRequest')
    .map(([, p]) => (p as { requestId: string }).requestId);
}

describe('Race gate through the Fetch.requestPaused handler', () => {
  afterEach(() => {
    jest.useRealTimers();
    for (const sm of managers.splice(0)) (sm as unknown as { shared: { raceGate: { dispose(): void } } }).shared.raceGate.dispose();
  });

  it('holds matching requests until holdCount have arrived, then releases them together', () => {
    const sm = makeManager();
    const s = sm.createSession('T');
    sm.addResilienceRule(s.id, raceRule());
    const dbg = dbgOf(s);
    dbg.sendCommand.mockClear();

    pause(dbg, 'a'); pause(dbg, 'b');
    expect(continued(dbg)).toEqual([]);          // still parked
    pause(dbg, 'c');
    expect(continued(dbg)).toEqual(['a', 'b', 'c']); // one pass, arrival order
  });

  it('lets non-matching requests (other URL or method) straight through', () => {
    const sm = makeManager();
    const s = sm.createSession('T');
    sm.addResilienceRule(s.id, raceRule());
    const dbg = dbgOf(s);
    dbg.sendCommand.mockClear();

    pause(dbg, 'other-url', 'https://shop.test/cart');
    pause(dbg, 'other-method', 'https://shop.test/redeem', 'GET');
    expect(continued(dbg)).toEqual(['other-url', 'other-method']);
  });

  it('fills one gate from two tabs on the same partition', () => {
    const sm = makeManager();
    const t1 = sm.createSession('One', { partition: 'persist:shared' });
    const t2 = sm.createSession('Two', { partition: 'persist:shared' });
    sm.addResilienceRule(t1.id, raceRule({ holdCount: 2 }));
    const d1 = dbgOf(t1); const d2 = dbgOf(t2);
    d1.sendCommand.mockClear(); d2.sendCommand.mockClear();

    pause(d1, 'tab1-req');
    expect(continued(d1)).toEqual([]);
    pause(d2, 'tab2-req');
    // Each request is released on the debugger of the tab that paused it.
    expect(continued(d1)).toEqual(['tab1-req']);
    expect(continued(d2)).toEqual(['tab2-req']);
  });

  it('does not share a gate between different partitions', () => {
    const sm = makeManager();
    const a = sm.createSession('A', { partition: 'persist:a' });
    const b = sm.createSession('B', { partition: 'persist:b' });
    sm.addResilienceRule(a.id, raceRule({ holdCount: 2 }));
    sm.addResilienceRule(b.id, raceRule({ holdCount: 2 }));
    const da = dbgOf(a); const db = dbgOf(b);
    da.sendCommand.mockClear(); db.sendCommand.mockClear();

    pause(da, 'a1'); pause(db, 'b1');
    expect(continued(da)).toEqual([]);
    expect(continued(db)).toEqual([]);
  });

  it('releases a partial batch when the timeout elapses', () => {
    jest.useFakeTimers();
    const sm = makeManager();
    const s = sm.createSession('T');
    sm.addResilienceRule(s.id, raceRule({ holdCount: 5, releaseAfterMs: 3000 }));
    const dbg = dbgOf(s);
    dbg.sendCommand.mockClear();

    pause(dbg, 'a'); pause(dbg, 'b');
    jest.advanceTimersByTime(2999);
    expect(continued(dbg)).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(continued(dbg)).toEqual(['a', 'b']);
  });

  it('applies the default timeout when the rule has none, so the page can never hang forever', () => {
    jest.useFakeTimers();
    const sm = makeManager();
    const s = sm.createSession('T');
    sm.addResilienceRule(s.id, raceRule({ holdCount: 5, releaseAfterMs: undefined }));
    const dbg = dbgOf(s);
    dbg.sendCommand.mockClear();

    pause(dbg, 'a');
    jest.advanceTimersByTime(9_999);
    expect(continued(dbg)).toEqual([]); // held right up to the default timeout
    jest.advanceTimersByTime(1);
    expect(continued(dbg)).toEqual(['a']);
  });

  it.each([
    ['removed', (sm: SessionManager, id: string) => sm.removeResilienceRule(id, 'race1')],
    ['disabled', (sm: SessionManager, id: string) => sm.toggleResilienceRule(id, 'race1', false)],
    ['edited', (sm: SessionManager, id: string) => sm.updateResilienceRule(id, 'race1', { holdCount: 10 })],
  ])('releases parked requests when the rule is %s', (_label, act) => {
    const sm = makeManager();
    const s = sm.createSession('T');
    sm.addResilienceRule(s.id, raceRule({ holdCount: 5 }));
    const dbg = dbgOf(s);
    dbg.sendCommand.mockClear();

    pause(dbg, 'a'); pause(dbg, 'b');
    expect(continued(dbg)).toEqual([]); // genuinely parked before the rule changes
    act(sm, s.id);
    expect(continued(dbg)).toEqual(['a', 'b']);
  });

  it('a closed tab\'s parked request no longer counts toward the batch', () => {
    const sm = makeManager();
    const t1 = sm.createSession('One', { partition: 'persist:shared' });
    const t2 = sm.createSession('Two', { partition: 'persist:shared' });
    sm.addResilienceRule(t1.id, raceRule({ holdCount: 2 }));
    const d2 = dbgOf(t2);
    d2.sendCommand.mockClear();

    pause(dbgOf(t1), 'dead');
    sm.destroySession(t1.id);
    pause(d2, 'live');
    expect(continued(d2)).toEqual([]); // 1 live request is not a full batch of 2
  });

  it('counts a hit per parked request and records the rule', () => {
    const sm = makeManager();
    const s = sm.createSession('T');
    sm.addResilienceRule(s.id, raceRule({ holdCount: 2 }));
    const dbg = dbgOf(s);
    pause(dbg, 'a'); pause(dbg, 'b');
    expect(sm.getResilienceRules(s.id)[0].hitCount).toBe(2);
  });
});
