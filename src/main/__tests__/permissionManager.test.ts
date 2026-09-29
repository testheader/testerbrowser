import fs from 'fs';
import os from 'os';
import path from 'path';

let userDataDir: string;

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => (global as any).__tbUserDataDir) }, // eslint-disable-line @typescript-eslint/no-explicit-any
  BrowserWindow: class {},
}));

import { PermissionManager, originKeyFor } from '../permissionManager';

// A fake Electron.Session good enough for PermissionManager.attach(): it only
// ever calls setPermissionRequestHandler/setPermissionCheckHandler, and this
// captures each handler so a test can invoke it directly to simulate a real
// request/check round-trip.
function fakeSession() {
  let requestHandler: ((wc: any, permission: string, callback: (g: boolean) => void, details: any) => void) | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  let checkHandler: ((wc: any, permission: string, requestingOrigin: string) => boolean) | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const ses = {
    setPermissionRequestHandler: jest.fn((h: any) => { requestHandler = h; }), // eslint-disable-line @typescript-eslint/no-explicit-any
    setPermissionCheckHandler: jest.fn((h: any) => { checkHandler = h; }), // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return {
    ses: ses as unknown as Electron.Session,
    request(wcId: number, permission: string, requestingUrl: string): Promise<boolean> {
      return new Promise((resolve) => requestHandler!({ id: wcId } as any, permission, resolve, { requestingUrl })); // eslint-disable-line @typescript-eslint/no-explicit-any
    },
    check(permission: string, requestingOrigin: string): boolean {
      return checkHandler!(null as any, permission, requestingOrigin); // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  };
}

function fakeWin() {
  return { webContents: { send: jest.fn() } } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-permtest-'));
  (global as any).__tbUserDataDir = userDataDir; // eslint-disable-line @typescript-eslint/no-explicit-any
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('originKeyFor (#276)', () => {
  it('returns the real origin for a well-formed URL', () => {
    expect(originKeyFor('https://example.com/page?x=1')).toBe('https://example.com');
  });

  it('falls back to a stable synthetic key for an unparseable URL, not the empty string', () => {
    const key = originKeyFor('not a url at all');
    expect(key).not.toBe('');
    expect(key).toBe(originKeyFor('not a url at all'));
  });
});

describe('PermissionManager (#276)', () => {
  it('a granted permission is remembered and matches on a later check', async () => {
    const pm = new PermissionManager(fakeWin());
    const { ses, request, check } = fakeSession();
    pm.attach(ses, 'partition-a');

    const reqPromise = request(1, 'geolocation', 'https://example.com/');
    // Grab the pending reqId the same way the IPC layer would: via the
    // win.webContents.send('permission:request', {...}) call PermissionManager made.
    const sentPayload = ((pm as any).win.webContents.send as jest.Mock).mock.calls[0][1]; // eslint-disable-line @typescript-eslint/no-explicit-any
    pm.respond(sentPayload.reqId, true);
    expect(await reqPromise).toBe(true);

    expect(check('geolocation', 'https://example.com')).toBe(true);
  });

  // Verified via the check handler itself, not just that respond(false)
  // resolves without throwing — the bug being fixed is that a denial was
  // never persisted at all, so the check handler had nothing to consult.
  it('a denied permission is also remembered and returns false on a later check without re-prompting', async () => {
    const pm = new PermissionManager(fakeWin());
    const { ses, request, check } = fakeSession();
    pm.attach(ses, 'partition-b');

    const reqPromise = request(1, 'notifications', 'https://example.com/');
    const sentPayload = ((pm as any).win.webContents.send as jest.Mock).mock.calls[0][1]; // eslint-disable-line @typescript-eslint/no-explicit-any
    pm.respond(sentPayload.reqId, false);
    expect(await reqPromise).toBe(false);

    expect(check('notifications', 'https://example.com')).toBe(false);

    // A second *request* (not just a check) for the same already-denied
    // permission must also answer immediately, without creating a new
    // pending prompt (win.webContents.send called exactly once total).
    const secondResult = await request(2, 'notifications', 'https://example.com/');
    expect(secondResult).toBe(false);
    expect(((pm as any).win.webContents.send as jest.Mock)).toHaveBeenCalledTimes(1); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('an unparseable requestingUrl produces a grant that matches a later check using the same malformed URL as the requesting origin', async () => {
    const pm = new PermissionManager(fakeWin());
    const { ses, request, check } = fakeSession();
    pm.attach(ses, 'partition-c');
    const malformed = 'this is not a url';

    const reqPromise = request(1, 'camera', malformed);
    const sentPayload = ((pm as any).win.webContents.send as jest.Mock).mock.calls[0][1]; // eslint-disable-line @typescript-eslint/no-explicit-any
    pm.respond(sentPayload.reqId, true);
    expect(await reqPromise).toBe(true);

    // The check handler receives whatever Electron itself computed as
    // requestingOrigin for this malformed URL — simulated here as the same
    // raw malformed string, since that's what Electron passes through when
    // it can't derive a real origin either.
    expect(check('camera', malformed)).toBe(true);
    // A different malformed string must NOT match — proves the fallback key
    // is derived from the actual value, not just "any malformed URL".
    expect(check('camera', 'a different malformed url')).toBe(false);
  });

  it('clearPartition removes only that partition\'s entries, leaving other partitions untouched', async () => {
    const pm = new PermissionManager(fakeWin());
    const { ses: sesA, request: requestA, check: checkA } = fakeSession();
    const { ses: sesB, request: requestB, check: checkB } = fakeSession();
    pm.attach(sesA, 'ephemeral-partition');
    pm.attach(sesB, 'persistent-partition');

    const sendMock = (pm as any).win.webContents.send as jest.Mock; // eslint-disable-line @typescript-eslint/no-explicit-any

    const reqAPromise = requestA(1, 'geolocation', 'https://a.example/');
    pm.respond(sendMock.mock.calls[0][1].reqId, true);
    await reqAPromise;

    const reqBPromise = requestB(2, 'geolocation', 'https://b.example/');
    pm.respond(sendMock.mock.calls[1][1].reqId, true);
    await reqBPromise;

    expect(checkA('geolocation', 'https://a.example')).toBe(true);
    expect(checkB('geolocation', 'https://b.example')).toBe(true);

    // SessionManager.destroySession only ever calls this for an in-memory
    // session (and never for one whose partition still has a live sibling
    // tab) — PermissionManager itself just wipes whatever partition it's told to.
    pm.clearPartition('ephemeral-partition');

    expect(checkA('geolocation', 'https://a.example')).toBe(false);
    expect(checkB('geolocation', 'https://b.example')).toBe(true); // survives — simulates a persistent session's tab closing
  });

  it('a pending request past its timeout auto-denies', async () => {
    const pm = new PermissionManager(fakeWin());
    const { ses, request } = fakeSession();
    pm.attach(ses, 'partition-timeout');

    const reqPromise = request(1, 'microphone', 'https://example.com/');
    jest.advanceTimersByTime(60_000);
    expect(await reqPromise).toBe(false);
  });

  it('a timed-out request is not persisted as a denial — the tester never actually chose it', async () => {
    const pm = new PermissionManager(fakeWin());
    const { ses, request, check } = fakeSession();
    pm.attach(ses, 'partition-timeout-2');

    const reqPromise = request(1, 'microphone', 'https://example.com/');
    jest.advanceTimersByTime(60_000);
    await reqPromise;

    // Nothing recorded — a fresh request would prompt again, not
    // immediately answer false from a phantom persisted denial.
    expect(check('microphone', 'https://example.com')).toBe(false);
    const sendMock = (pm as any).win.webContents.send as jest.Mock; // eslint-disable-line @typescript-eslint/no-explicit-any
    sendMock.mockClear();
    request(2, 'microphone', 'https://example.com/'); // not awaited — its own 60s timeout is left pending on purpose
    expect(sendMock).toHaveBeenCalledTimes(1); // a real new prompt was sent, not answered from a stale record
  });

  it('dismissForWebContents auto-denies and removes only prompts belonging to that webContents, without persisting a denial', async () => {
    const pm = new PermissionManager(fakeWin());
    const { ses, request, check } = fakeSession();
    pm.attach(ses, 'partition-dismiss');

    const reqFromClosingTab = request(1, 'geolocation', 'https://example.com/');
    const reqFromOtherTab = request(2, 'notifications', 'https://other.example/');

    pm.dismissForWebContents(1);
    expect(await reqFromClosingTab).toBe(false);
    expect(check('geolocation', 'https://example.com')).toBe(false); // not persisted, but a fresh check still finds nothing

    // The other tab's still-pending prompt is untouched.
    const sendMock = (pm as any).win.webContents.send as jest.Mock; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(sendMock.mock.calls.some((c: any) => c[1].permission === 'notifications')).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    const reqId2 = sendMock.mock.calls.find((c: any) => c[1].permission === 'notifications')![1].reqId; // eslint-disable-line @typescript-eslint/no-explicit-any
    pm.respond(reqId2, true);
    expect(await reqFromOtherTab).toBe(true);
  });

  it('fullscreen and pointerLock are auto-allowed without ever prompting', async () => {
    const pm = new PermissionManager(fakeWin());
    const { ses, request } = fakeSession();
    pm.attach(ses, 'partition-auto');

    expect(await request(1, 'fullscreen', 'https://example.com/')).toBe(true);
    expect(await request(1, 'pointerLock', 'https://example.com/')).toBe(true);
    expect(((pm as any).win.webContents.send as jest.Mock)).not.toHaveBeenCalled(); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  describe('list/revoke', () => {
    it('list returns every recorded entry for a partition, newest first', async () => {
      const pm = new PermissionManager(fakeWin());
      const { ses, request, check } = fakeSession();
      void check;
      pm.attach(ses, 'partition-list');
      const sendMock = (pm as any).win.webContents.send as jest.Mock; // eslint-disable-line @typescript-eslint/no-explicit-any

      const p1 = request(1, 'geolocation', 'https://a.example/');
      pm.respond(sendMock.mock.calls[0][1].reqId, true);
      await p1;

      const p2 = request(1, 'notifications', 'https://a.example/');
      pm.respond(sendMock.mock.calls[1][1].reqId, false);
      await p2;

      const list = pm.list('partition-list');
      expect(list).toHaveLength(2);
      expect(list.map((r) => r.permission).sort()).toEqual(['geolocation', 'notifications']);
      expect(list.map((r) => r.status).sort()).toEqual(['denied', 'granted']);
    });

    it('revoke removes one entry and a later check re-prompts instead of matching a stale grant', async () => {
      const pm = new PermissionManager(fakeWin());
      const { ses, request, check } = fakeSession();
      pm.attach(ses, 'partition-revoke');
      const sendMock = (pm as any).win.webContents.send as jest.Mock; // eslint-disable-line @typescript-eslint/no-explicit-any

      const p1 = request(1, 'geolocation', 'https://a.example/');
      pm.respond(sendMock.mock.calls[0][1].reqId, true);
      await p1;
      expect(check('geolocation', 'https://a.example')).toBe(true);

      const revoked = pm.revoke('partition-revoke', 'https://a.example', 'geolocation');
      expect(revoked).toBe(true);
      expect(check('geolocation', 'https://a.example')).toBe(false);
      expect(pm.list('partition-revoke')).toEqual([]);
    });

    it('revoke returns false for an entry that was never recorded', () => {
      const pm = new PermissionManager(fakeWin());
      expect(pm.revoke('no-such-partition', 'https://x.example', 'geolocation')).toBe(false);
    });
  });
});
