import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { NEWTAB_CHANNELS, installIpcGuard, isAllowedIpcSender } from '../ipcGuard';
import { NEWTAB_FILE } from '../newtabUrl';

const appWc = { id: 1 } as unknown as WebContents;
const tabWc = { id: 2 } as unknown as WebContents;
const NEWTAB_URL = pathToFileURL(NEWTAB_FILE).href;
const APP_URL = pathToFileURL(path.resolve(NEWTAB_FILE, '..', 'index.html')).href;

function ev(sender: WebContents, url: string, parent: unknown = null): IpcMainInvokeEvent {
  return { sender, senderFrame: { url, parent } } as unknown as IpcMainInvokeEvent;
}

describe('isAllowedIpcSender', () => {
  it('lets the chrome window call any channel', () => {
    expect(isAllowedIpcSender('app:openExternal', ev(appWc, APP_URL), appWc)).toBe(true);
    expect(isAllowedIpcSender('settings:set', ev(appWc, APP_URL), appWc)).toBe(true);
  });

  it('rejects an iframe inside the chrome window', () => {
    expect(isAllowedIpcSender('settings:get', ev(appWc, 'https://evil.test/', {}), appWc)).toBe(false);
  });

  it('rejects a sender whose frame is gone', () => {
    const e = { sender: appWc, senderFrame: null } as unknown as IpcMainInvokeEvent;
    expect(isAllowedIpcSender('settings:get', e, appWc)).toBe(false);
  });

  it('lets the new-tab page call only its own channels', () => {
    for (const channel of NEWTAB_CHANNELS) {
      expect(isAllowedIpcSender(channel, ev(tabWc, NEWTAB_URL), appWc)).toBe(true);
    }
    expect(isAllowedIpcSender('bookmarks:add', ev(tabWc, NEWTAB_URL), appWc)).toBe(false);
    expect(isAllowedIpcSender('app:openExternal', ev(tabWc, NEWTAB_URL), appWc)).toBe(false);
  });

  it('rejects a website under test on every channel', () => {
    for (const channel of ['settings:get', 'clipboard:write', 'app:openExternal', 'jira:createIssue']) {
      expect(isAllowedIpcSender(channel, ev(tabWc, 'https://site-under-test.example/'), appWc)).toBe(false);
    }
  });

  it('rejects everything but the new-tab page before the chrome window exists', () => {
    expect(isAllowedIpcSender('sessions:list', ev(appWc, APP_URL), null)).toBe(false);
    expect(isAllowedIpcSender('settings:get', ev(tabWc, NEWTAB_URL), null)).toBe(true);
  });
});

describe('installIpcGuard', () => {
  function fakeIpc() {
    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipc = {
      handle: (c: string, fn: never) => { handlers.set(c, fn); },
      handleOnce: (c: string, fn: never) => { handlers.set(c, fn); },
    } as unknown as IpcMain;
    return { ipc, handlers };
  }

  it.each(['handle', 'handleOnce'] as const)('guards ipcMain.%s registrations', (method) => {
    const { ipc, handlers } = fakeIpc();
    const onReject = jest.fn();
    installIpcGuard(ipc, { getAppWebContents: () => appWc, onReject });
    const listener = jest.fn((_e: unknown, x: number) => x * 2);
    ipc[method]('clipboard:write', listener);
    const wrapped = handlers.get('clipboard:write')!;

    expect(wrapped(ev(appWc, APP_URL), 21)).toBe(42);
    expect(onReject).not.toHaveBeenCalled();

    expect(() => wrapped(ev(tabWc, 'https://evil.test/page'), 1)).toThrow(/untrusted sender/);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith('clipboard:write', 'https://evil.test');
  });

  it('reads the chrome window lazily, so it can be created after install', () => {
    const { ipc, handlers } = fakeIpc();
    let win: WebContents | null = null;
    installIpcGuard(ipc, { getAppWebContents: () => win, onReject: () => {} });
    ipc.handle('sessions:list', () => 'ok');
    expect(() => handlers.get('sessions:list')!(ev(appWc, APP_URL))).toThrow();
    win = appWc;
    expect(handlers.get('sessions:list')!(ev(appWc, APP_URL))).toBe('ok');
  });
});

describe('ipcGuard drift checks', () => {
  const srcMain = path.join(__dirname, '..');

  it('NEWTAB_CHANNELS matches exactly what src/preload/newtab.ts invokes', () => {
    const preload = fs.readFileSync(path.join(srcMain, '..', 'preload', 'newtab.ts'), 'utf8');
    const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]));
    expect([...invoked].sort()).toEqual([...NEWTAB_CHANNELS].sort());
  });

  it('index.ts installs the guard before registering any handler', () => {
    const index = fs.readFileSync(path.join(srcMain, 'index.ts'), 'utf8');
    const install = index.indexOf('installIpcGuard(ipcMain');
    const firstRegister = index.search(/^register\w+Ipc\(/m);
    expect(install).toBeGreaterThan(-1);
    expect(firstRegister).toBeGreaterThan(install);
  });

  it('no main-process code registers through the unguarded ipcMain.on/once/addListener', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        if (/ipcMain\.(on|once|addListener|prependListener)\(/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(srcMain);
    expect(offenders).toEqual([]);
  });
});
