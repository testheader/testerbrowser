import type { BrowserWindow } from 'electron';

// SessionManager's constructor only touches `app.getPath` from electron at
// construction time (via dbDir); every other electron import it uses (Menu,
// dialog, WebContentsView, session, clipboard) is only referenced inside
// methods this test never calls directly (createSession() itself is mocked
// out below wherever it would otherwise run).
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/tb-mock-resilience-scope-test') },
}));

import { SessionManager } from '../sessionManager';
import type { TestSession, MockRule, ResilienceRule } from '../sessionManager';

function makeManager(): SessionManager {
  const win = { on: jest.fn() } as unknown as BrowserWindow;
  return new SessionManager(win, () => false);
}

// Installs a fake TestSession directly into the manager's private session
// map, bypassing the real createSession() (which needs a real
// WebContentsView) — same problem/solution as emulation.test.ts's own
// installFakeSessionFull, extended here with a debugger mock so
// addMockRule()/addResilienceRule()'s _applyFetch() call has something to
// call sendCommand on, and with session.cookies.get for cloneSession().
function installFakeSession(sm: SessionManager, opts: { id: string; partition: string; persistent?: boolean }) {
  const session = {
    id: opts.id,
    name: opts.id,
    partition: opts.partition,
    persistent: opts.persistent ?? true,
    view: {
      webContents: {
        debugger: { sendCommand: jest.fn().mockResolvedValue({}) },
        session: { cookies: { get: jest.fn().mockResolvedValue([]) } },
      },
    },
  };
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(opts.id, session);
  return session;
}

function makeMockRule(id: string, overrides: Partial<MockRule> = {}): MockRule {
  return {
    id, urlPattern: '*', method: '*', statusCode: 200, body: '',
    responseHeaders: {}, enabled: true, hitCount: 0, lastHitAt: null,
    ...overrides,
  };
}

function makeResilienceRule(id: string, overrides: Partial<ResilienceRule> = {}): ResilienceRule {
  return {
    id, type: 'error500', urlPattern: '*', method: '*', probability: 100, latencyMs: 0,
    enabled: true, hitCount: 0, lastHitAt: null,
    ...overrides,
  };
}

describe('mock/resilience rules are scoped to the session partition, not the per-tab id (#209)', () => {
  it('two tabs sharing one partition see the same mock rules, in both directions', () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'tab-a', partition: 'persist:shared' });
    installFakeSession(sm, { id: 'tab-b', partition: 'persist:shared' });

    sm.addMockRule('tab-a', makeMockRule('m1', { urlPattern: 'https://api.example.com/*' }));

    expect(sm.getMockRules('tab-b').map(r => r.id)).toEqual(['m1']);

    sm.addMockRule('tab-b', makeMockRule('m2'));
    expect(sm.getMockRules('tab-a').map(r => r.id)).toEqual(['m1', 'm2']);

    sm.toggleMockRule('tab-b', 'm1', false);
    expect(sm.getMockRules('tab-a').find(r => r.id === 'm1')?.enabled).toBe(false);

    sm.removeMockRule('tab-a', 'm2');
    expect(sm.getMockRules('tab-b').map(r => r.id)).toEqual(['m1']);
  });

  it('two tabs sharing one partition see the same resilience rules, in both directions', () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'tab-a', partition: 'persist:shared-res' });
    installFakeSession(sm, { id: 'tab-b', partition: 'persist:shared-res' });

    sm.addResilienceRule('tab-a', makeResilienceRule('r1'));
    expect(sm.getResilienceRules('tab-b').map(r => r.id)).toEqual(['r1']);

    sm.updateResilienceRule('tab-b', 'r1', { probability: 50 });
    expect(sm.getResilienceRules('tab-a').find(r => r.id === 'r1')?.probability).toBe(50);
  });

  it('two tabs on genuinely different partitions never see each other\'s rules', () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'tab-a', partition: 'persist:one' });
    installFakeSession(sm, { id: 'tab-b', partition: 'persist:two' });

    sm.addMockRule('tab-a', makeMockRule('m1'));
    sm.addResilienceRule('tab-a', makeResilienceRule('r1'));

    expect(sm.getMockRules('tab-b')).toEqual([]);
    expect(sm.getResilienceRules('tab-b')).toEqual([]);
    expect(sm.getMockRules('tab-a').map(r => r.id)).toEqual(['m1']);
  });

  it('reopening a closed tab (new TestSession id, same partition) recovers the rules that were active before it closed', () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'tab-1', partition: 'persist:x' });
    sm.addMockRule('tab-1', makeMockRule('m1'));
    sm.addResilienceRule('tab-1', makeResilienceRule('r1'));

    // Simulate destroySession('tab-1') without the parts that need a real
    // WebContentsView/recorder (view.webContents.destroy(), recorder.destroy()) —
    // what matters here is only that it removes 'tab-1' from the sessions map
    // while leaving the partition-keyed rule maps untouched, which is exactly
    // what the real destroySession() does per #209.
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.delete('tab-1');

    // A fresh tab reopens the same partition under a brand-new id.
    installFakeSession(sm, { id: 'tab-2', partition: 'persist:x' });

    expect(sm.getMockRules('tab-2').map(r => r.id)).toEqual(['m1']);
    expect(sm.getResilienceRules('tab-2').map(r => r.id)).toEqual(['r1']);
  });

  it('cloneSession() copies the source\'s rules into the clone as an independent copy', async () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'src-1', partition: 'persist:src', persistent: true });
    sm.addMockRule('src-1', makeMockRule('m1'));
    sm.addResilienceRule('src-1', makeResilienceRule('r1'));

    // createSession() itself needs a real WebContentsView/session partition —
    // mock it out the way emulation.test.ts's restore tests do, but still
    // exercise cloneSession()'s own rule-copying logic around it.
    jest.spyOn(sm, 'createSession').mockImplementation((name: string) => {
      const dest = installFakeSession(sm, { id: 'dest-1', partition: 'persist:dest', persistent: true });
      dest.name = name;
      return dest as unknown as TestSession;
    });

    const dest = await sm.cloneSession('src-1', 'Clone of src');

    expect(dest?.id).toBe('dest-1');
    expect(sm.getMockRules('dest-1')).toEqual(sm.getMockRules('src-1'));
    expect(sm.getResilienceRules('dest-1')).toEqual(sm.getResilienceRules('src-1'));

    // Mutating the clone afterward must not affect the source, and vice versa.
    sm.addMockRule('dest-1', makeMockRule('m2'));
    expect(sm.getMockRules('src-1').map(r => r.id)).toEqual(['m1']);
    expect(sm.getMockRules('dest-1').map(r => r.id)).toEqual(['m1', 'm2']);

    sm.removeResilienceRule('src-1', 'r1');
    expect(sm.getResilienceRules('src-1')).toEqual([]);
    expect(sm.getResilienceRules('dest-1').map(r => r.id)).toEqual(['r1']);
  });
});
