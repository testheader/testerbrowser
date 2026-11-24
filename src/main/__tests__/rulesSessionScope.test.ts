import type { BrowserWindow } from 'electron';

// SessionManager's constructor only touches `app.getPath` from electron at
// construction time (via dbDir); every other electron import it uses is only
// referenced inside methods this test never calls directly (createSession()
// itself is mocked out below wherever it would otherwise run).
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/tb-rules-scope-test') },
}));

import { SessionManager } from '../sessionManager';
import type { TestSession } from '../sessionManager';
import { makeMockRule, makeRule } from './ruleFactories';

function makeManager(): SessionManager {
  const win = { on: jest.fn() } as unknown as BrowserWindow;
  return new SessionManager(win, () => false);
}

// Installs a fake TestSession directly into the manager's private session map,
// bypassing the real createSession() (which needs a real WebContentsView) —
// with a debugger mock so addRule()'s _applyFetch() call has something to call
// sendCommand on, and with session.cookies.get for cloneSession().
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

describe('rules are scoped to the session partition, not the per-tab id (#209, #370)', () => {
  it('two tabs sharing one partition see the same rules, in both directions', () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'tab-a', partition: 'persist:shared' });
    installFakeSession(sm, { id: 'tab-b', partition: 'persist:shared' });

    sm.addRule('tab-a', makeMockRule('m1', { urlPattern: 'https://api.example.com/*' }));
    expect(sm.getRules('tab-b').map(r => r.id)).toEqual(['m1']);

    sm.addRule('tab-b', makeRule('f1', { kind: 'fail', mode: 'error500' }));
    expect(sm.getRules('tab-a').map(r => r.id)).toEqual(['m1', 'f1']);

    sm.toggleRule('tab-b', 'm1', false);
    expect(sm.getRules('tab-a').find(r => r.id === 'm1')?.enabled).toBe(false);

    expect(sm.updateRule('tab-b', 'f1', { probability: 0.5 })).toBe(true);
    expect(sm.getRules('tab-a').find(r => r.id === 'f1')?.probability).toBe(0.5);

    sm.removeRule('tab-a', 'f1');
    expect(sm.getRules('tab-b').map(r => r.id)).toEqual(['m1']);
  });

  it('updateRule reports false for a rule that is gone or a tab that is gone', () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'tab-a', partition: 'persist:x' });
    expect(sm.updateRule('tab-a', 'nope', { enabled: false })).toBe(false);
    expect(sm.updateRule('closed-tab', 'nope', { enabled: false })).toBe(false);
  });

  it('two tabs on genuinely different partitions never see each other\'s rules', () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'tab-a', partition: 'persist:one' });
    installFakeSession(sm, { id: 'tab-b', partition: 'persist:two' });

    sm.addRule('tab-a', makeMockRule('m1'));

    expect(sm.getRules('tab-b')).toEqual([]);
    expect(sm.getRules('tab-a').map(r => r.id)).toEqual(['m1']);
  });

  it('reopening a closed tab (new TestSession id, same partition) recovers the rules that were active before it closed', () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'tab-1', partition: 'persist:x' });
    sm.addRule('tab-1', makeMockRule('m1'));
    sm.addRule('tab-1', makeRule('f1', { kind: 'fail', mode: 'offline' }));

    // Simulate destroySession('tab-1') without the parts that need a real
    // WebContentsView/recorder: it removes 'tab-1' from the sessions map while
    // leaving the partition-keyed rules untouched, as the real one does.
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.delete('tab-1');
    installFakeSession(sm, { id: 'tab-2', partition: 'persist:x' });

    expect(sm.getRules('tab-2').map(r => r.id)).toEqual(['m1', 'f1']);
  });

  it('dragging a rule to a new position changes which rule wins', () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'tab-a', partition: 'persist:order' });
    sm.addRule('tab-a', makeMockRule('first', { urlPattern: '*/api/*' }));
    sm.addRule('tab-a', makeMockRule('second', { urlPattern: '*/api/*' }));
    sm.addRule('tab-a', makeMockRule('third', { urlPattern: '*/api/*' }));

    expect(sm.findMatchingRule('tab-a', 'GET', 'https://x.test/api/a')?.id).toBe('first');
    sm.reorderRule('tab-a', 'third', 0);
    expect(sm.getRules('tab-a').map(r => r.id)).toEqual(['third', 'first', 'second']);
    expect(sm.findMatchingRule('tab-a', 'GET', 'https://x.test/api/a')?.id).toBe('third');
    sm.moveRule('tab-a', 'third', 'down');
    expect(sm.getRules('tab-a').map(r => r.id)).toEqual(['first', 'third', 'second']);
  });

  it('cloneSession() copies the source\'s rules into the clone as an independent copy', async () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'src-1', partition: 'persist:src', persistent: true });
    sm.addRule('src-1', makeMockRule('m1'));
    sm.addRule('src-1', makeRule('f1', { kind: 'fail', mode: 'error500' }));

    // createSession() itself needs a real WebContentsView/session partition —
    // mock it out but still exercise cloneSession()'s own rule-copying logic.
    jest.spyOn(sm, 'createSession').mockImplementation((name: string) => {
      const dest = installFakeSession(sm, { id: 'dest-1', partition: 'persist:dest', persistent: true });
      dest.name = name;
      return dest as unknown as TestSession;
    });

    const dest = await sm.cloneSession('src-1', 'Clone of src');

    expect(dest?.session.id).toBe('dest-1');
    expect(dest?.warnings).toEqual([]);
    expect(sm.getRules('dest-1')).toEqual(sm.getRules('src-1'));

    // Mutating the clone afterward must not affect the source, and vice versa.
    sm.addRule('dest-1', makeMockRule('m2'));
    expect(sm.getRules('src-1').map(r => r.id)).toEqual(['m1', 'f1']);
    expect(sm.getRules('dest-1').map(r => r.id)).toEqual(['m1', 'f1', 'm2']);

    sm.removeRule('src-1', 'f1');
    expect(sm.getRules('src-1').map(r => r.id)).toEqual(['m1']);
    expect(sm.getRules('dest-1').map(r => r.id)).toEqual(['m1', 'f1', 'm2']);
  });
});
