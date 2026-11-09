import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

let userDataDir: string;

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => (global as any).__tbUserDataDir) }, // eslint-disable-line @typescript-eslint/no-explicit-any
  BrowserWindow: class {},
  shell: {},
}));

import { DownloadManager } from '../downloadManager';
import { PermissionManager } from '../permissionManager';

// Two windows share one Electron session (same partition). The session-wide
// hooks must be installed once and send each event to the window that owns the
// requesting tab (#367).

function fakeWin() {
  return { webContents: { send: jest.fn() } } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function fakeItem(name: string) {
  const item: any = new EventEmitter(); // eslint-disable-line @typescript-eslint/no-explicit-any
  item.getFilename = () => name;
  item.getURL = () => 'http://x/' + name;
  item.getTotalBytes = () => 10;
  item.setSavePath = jest.fn();
  return item;
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-multiwin-hooks-'));
  (global as any).__tbUserDataDir = userDataDir; // eslint-disable-line @typescript-eslint/no-explicit-any
  jest.spyOn(fs, 'existsSync').mockReturnValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('DownloadManager across windows', () => {
  function twoWindows() {
    const winA = fakeWin();
    const winB = fakeWin();
    const a = new DownloadManager(winA, { ownsWebContents: (id) => id === 1, getSessionId: (id) => (id === 1 ? 'tab-a' : null) });
    const b = new DownloadManager(winB, { ownsWebContents: (id) => id === 2, getSessionId: (id) => (id === 2 ? 'tab-b' : null) });
    const ses: any = new EventEmitter(); // eslint-disable-line @typescript-eslint/no-explicit-any
    a.attach(ses, 'tab-a');
    b.attach(ses, 'tab-b');
    return { a, b, winA, winB, ses };
  }

  it('records a download once, in the window that owns the requesting tab', () => {
    const { a, b, winA, winB, ses } = twoWindows();
    ses.emit('will-download', {}, fakeItem('file.txt'), { id: 2 });
    expect(a.list()).toHaveLength(0);
    expect(b.list()).toHaveLength(1);
    expect(winB.webContents.send).toHaveBeenCalledWith('download:update', expect.objectContaining({ filename: 'file.txt' }));
    expect(winA.webContents.send).not.toHaveBeenCalled();
    a.dispose(); b.dispose();
  });

  it('attributes the download to the tab that started it, not the tab that first hooked the session', () => {
    const { a, b, ses } = twoWindows();
    ses.emit('will-download', {}, fakeItem('one.txt'), { id: 2 });
    expect(b.list()[0].sessionId).toBe('tab-b');
    ses.emit('will-download', {}, fakeItem('two.txt'), { id: 1 });
    expect(a.list()[0].sessionId).toBe('tab-a');
    a.dispose(); b.dispose();
  });

  it('stops routing to a window once it is disposed', () => {
    const { a, b, ses } = twoWindows();
    b.dispose();
    ses.emit('will-download', {}, fakeItem('late.txt'), { id: 2 });
    expect(a.list()).toHaveLength(1); // falls back to a live window
    expect(b.list()).toHaveLength(0);
    a.dispose();
  });
});

describe('PermissionManager across windows', () => {
  function fakeSession() {
    let request: ((wc: any, permission: string, cb: (g: boolean) => void, details: any) => void) | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ses = {
      setPermissionRequestHandler: jest.fn((h: any) => { request = h; }), // eslint-disable-line @typescript-eslint/no-explicit-any
      setPermissionCheckHandler: jest.fn(),
    };
    return {
      ses: ses as unknown as Electron.Session,
      setRequestHandlerCalls: () => ses.setPermissionRequestHandler.mock.calls.length,
      request: (wcId: number) => request!({ id: wcId }, 'geolocation', () => {}, { requestingUrl: 'https://site.test/' }),
    };
  }

  it('installs the handler once and prompts only in the window that owns the tab', () => {
    jest.useFakeTimers(); // the pending prompt's 60s auto-deny timer must not outlive the test
    const store = PermissionManager.createStore();
    const winA = fakeWin();
    const winB = fakeWin();
    const a = new PermissionManager(winA, (id) => (id === 1 ? 'tab-a' : null), (id) => id === 1, store);
    const b = new PermissionManager(winB, (id) => (id === 2 ? 'tab-b' : null), (id) => id === 2, store);
    const s = fakeSession();
    a.attach(s.ses, 'persist:shared');
    b.attach(s.ses, 'persist:shared');
    expect(s.setRequestHandlerCalls()).toBe(1);

    s.request(2);
    expect(winB.webContents.send).toHaveBeenCalledWith('permission:request', expect.objectContaining({ sessionId: 'tab-b' }));
    expect(winA.webContents.send).not.toHaveBeenCalled();
    jest.useRealTimers();
    a.dispose(); b.dispose();
  });

  it('a grant made in one window is remembered for the other (shared store)', () => {
    const store = PermissionManager.createStore();
    const a = new PermissionManager(fakeWin(), () => null, (id) => id === 1, store);
    const b = new PermissionManager(fakeWin(), () => null, (id) => id === 2, store);
    jest.useFakeTimers();
    const s = fakeSession();
    a.attach(s.ses, 'persist:shared');
    s.request(1);
    const reqId = [...(a as any).pendingPermissions.keys()][0]; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.respond(reqId, true);
    expect(b.list('persist:shared')).toHaveLength(1);
    jest.useRealTimers();
    a.dispose(); b.dispose();
  });
});
