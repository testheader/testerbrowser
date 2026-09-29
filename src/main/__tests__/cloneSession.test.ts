import type { BrowserWindow } from 'electron';

// SessionManager's constructor only touches `app.getPath` from electron at
// construction time (via dbDir); every other electron import it uses is only
// referenced inside methods this test never calls directly (createSession()
// itself is mocked out below wherever it would otherwise run).
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/tb-clone-session-test') },
}));

import { SessionManager } from '../sessionManager';
import type { TestSession, EmulationOverrides } from '../sessionManager';

function makeManager(): SessionManager {
  const win = { on: jest.fn() } as unknown as BrowserWindow;
  return new SessionManager(win, () => false);
}

// Installs a fake TestSession directly into the manager's private session
// map, bypassing the real createSession() (which needs a real
// WebContentsView) — same technique as mockResilienceSessionScope.test.ts's
// own installFakeSession, extended with `currentUrl` (left '' so
// cloneSession()'s storage-seed/navigate branch, which needs a real
// mainFrame/loadURL, is never exercised here) and an injectable cookies.get.
function installFakeSession(
  sm: SessionManager,
  opts: { id: string; partition: string; persistent?: boolean; currentUrl?: string; cookiesGet?: jest.Mock; cookiesSet?: jest.Mock }
) {
  const session = {
    id: opts.id,
    name: opts.id,
    partition: opts.partition,
    persistent: opts.persistent ?? true,
    currentUrl: opts.currentUrl ?? '',
    defaultUserAgent: 'real-ua',
    view: {
      webContents: {
        debugger: { sendCommand: jest.fn().mockResolvedValue({}) },
        setUserAgent: jest.fn(),
        getUserAgent: jest.fn(() => 'real-ua'),
        session: {
          cookies: {
            get: opts.cookiesGet ?? jest.fn().mockResolvedValue([]),
            set: opts.cookiesSet ?? jest.fn().mockResolvedValue(undefined),
          },
        },
      },
    },
  };
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(opts.id, session);
  return session;
}

function setEmulationFor(sm: SessionManager, partition: string, overrides: EmulationOverrides) {
  (sm as unknown as { emulationByPartition: Map<string, EmulationOverrides> })
    .emulationByPartition.set(partition, overrides);
}

function mockDestCreation(sm: SessionManager, destId: string) {
  jest.spyOn(sm, 'createSession').mockImplementation((name: string) => {
    const dest = installFakeSession(sm, { id: destId, partition: `persist:${destId}` });
    dest.name = name;
    return dest as unknown as TestSession;
  });
}

describe('cloneSession (#269)', () => {
  it('keeps sameSite when copying cookies to the clone', async () => {
    const sm = makeManager();
    const cookiesGet = jest.fn().mockResolvedValue([
      { name: 'sid', value: 'abc', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'strict' },
    ]);
    const cookiesSet = jest.fn().mockResolvedValue(undefined);
    installFakeSession(sm, { id: 'src-1', partition: 'persist:src', cookiesGet });
    // Route the mocked createSession()'s installFakeSession call through the
    // same cookiesSet mock as the real dest session it installs.
    jest.spyOn(sm, 'createSession').mockImplementation((name: string) => {
      const dest = installFakeSession(sm, { id: 'dest-1', partition: 'persist:dest', cookiesSet });
      dest.name = name;
      return dest as unknown as TestSession;
    });

    const result = await sm.cloneSession('src-1', 'Clone of src');

    expect(result?.warnings).toEqual([]);
    expect(cookiesSet).toHaveBeenCalledWith(expect.objectContaining({ name: 'sid', sameSite: 'strict' }));
  });

  it("a cookie-set failure doesn't stop the rest and is reported in warnings", async () => {
    const sm = makeManager();
    const cookiesGet = jest.fn().mockResolvedValue([
      { name: 'bad', value: '1', domain: 'example.com', path: '/', secure: true, httpOnly: false, sameSite: 'lax' },
      { name: 'good', value: '2', domain: 'example.com', path: '/', secure: true, httpOnly: false, sameSite: 'lax' },
    ]);
    const cookiesSet = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    installFakeSession(sm, { id: 'src-1', partition: 'persist:src', cookiesGet });
    jest.spyOn(sm, 'createSession').mockImplementation((name: string) => {
      const dest = installFakeSession(sm, { id: 'dest-1', partition: 'persist:dest', cookiesSet });
      dest.name = name;
      return dest as unknown as TestSession;
    });

    const result = await sm.cloneSession('src-1', 'Clone of src');

    // Both cookies were attempted despite the first one failing.
    expect(cookiesSet).toHaveBeenCalledTimes(2);
    expect(cookiesSet).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: 'good' }));
    expect(result?.warnings).toEqual([expect.stringContaining("cookie 'bad'")]);
    expect(result?.warnings[0]).toContain('boom');
  });

  it('copies emulation overrides from source to the clone', async () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'src-1', partition: 'persist:src' });
    setEmulationFor(sm, 'persist:src', { timezone: 'Europe/Berlin', locale: 'de-DE' });
    mockDestCreation(sm, 'dest-1');

    const result = await sm.cloneSession('src-1', 'Clone of src');

    expect(result?.warnings).toEqual([]);
    // setEmulation() ran against the clone's own partition, not the source's.
    expect(sm.getEmulation('dest-1')).toMatchObject({ timezone: 'Europe/Berlin', locale: 'de-DE' });
  });

  it('a source tab still on the new-tab page (empty currentUrl) clones without navigating', async () => {
    const sm = makeManager();
    installFakeSession(sm, { id: 'src-1', partition: 'persist:src', currentUrl: '' });
    mockDestCreation(sm, 'dest-1');

    const result = await sm.cloneSession('src-1', 'Clone of src');

    expect(result?.session.id).toBe('dest-1');
    expect(result?.warnings).toEqual([]);
  });

  it('returns null when the source session no longer exists', async () => {
    const sm = makeManager();
    expect(await sm.cloneSession('missing', 'Clone')).toBeNull();
  });
});
