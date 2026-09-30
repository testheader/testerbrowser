import { ipcMain, clipboard } from 'electron';
import type { EmulationOverrides } from '../emulationManager';
import type { AppDeps } from './deps';

/** Tab lifecycle, navigation, notes, storage panel and misc per-session IPC. */
export function registerSessionsIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('sessions:list',    () => getSessionManager()?.listSessions() ?? []);
  ipcMain.handle('sessions:create',  (_e, name: string, opts) => getSessionManager()?.createSession(name, opts).id);
  ipcMain.handle('sessions:switch',  (_e, id: string) => getSessionManager()?.switchTo(id));
  ipcMain.handle('sessions:destroy', (_e, id: string) => getSessionManager()?.destroySession(id));
  ipcMain.handle('sessions:navigate',(_e, id: string, url: string) => getSessionManager()?.navigate(id, url));
  ipcMain.handle('sessions:rename',  (_e, id: string, name: string) => getSessionManager()?.renameSession(id, name));
  ipcMain.handle('sessions:pin',     (_e, id: string, pinned: boolean) => getSessionManager()?.pinSession(id, pinned));
  ipcMain.handle('sessions:setTabOrder', (_e, order: string[]) => getSessionManager()?.setTabOrder(order));
  ipcMain.handle('sessions:reopen',  async (_e, opts: {
    name: string; url: string | null; partition: string; color?: string;
    pinned?: boolean; notes?: string; emulation?: EmulationOverrides;
  }) => {
    // Only restore http/https URLs; null/empty falls through to the newtab page
    const startUrl = /^https?:\/\//i.test(opts.url ?? '') ? (opts.url as string) : undefined;
    const sm = getSessionManager();
    const s = sm?.createSession(opts.name, { partition: opts.partition, startUrl, color: opts.color, pinned: opts.pinned });
    if (!s) return null;
    if (opts.notes) sm?.setNotes(s.id, opts.notes);
    if (opts.emulation) await sm?.setEmulation(s.id, opts.emulation);
    return s.id;
  });

  ipcMain.handle('sessions:clone', async (_e, sourceId: string, newName: string) => {
    const c = await getSessionManager()?.cloneSession(sourceId, newName);
    return { id: c?.session.id ?? null, warnings: c?.warnings ?? [] };
  });

  ipcMain.handle('sessions:back',     (_e, id: string) => getSessionManager()?.back(id));
  ipcMain.handle('sessions:forward',  (_e, id: string) => getSessionManager()?.forward(id));
  ipcMain.handle('sessions:reload',   (_e, id: string) => getSessionManager()?.reload(id));
  ipcMain.handle('sessions:stop',     (_e, id: string) => getSessionManager()?.stop(id));
  ipcMain.handle('sessions:setZoom',  (_e, id: string, delta: number) => getSessionManager()?.setZoom(id, delta));
  ipcMain.handle('sessions:resetZoom',(_e, id: string) => getSessionManager()?.resetZoom(id));
  ipcMain.handle('sessions:getZoom',  (_e, id: string) => getSessionManager()?.getZoom(id) ?? 1);
  ipcMain.handle('devtools:toggle',   (_e, id: string) => getSessionManager()?.toggleDevTools(id));

  ipcMain.handle('find:start', (_e, id: string, text: string, forward: boolean, findNext: boolean) =>
    getSessionManager()?.findInPage(id, text, forward, findNext)
  );
  ipcMain.handle('find:stop', (_e, id: string) => getSessionManager()?.stopFind(id));

  ipcMain.handle('sessions:notes:get', (_e, id: string) => getSessionManager()?.getNotes(id) ?? '');
  ipcMain.handle('sessions:notes:set', (_e, id: string, notes: string) => getSessionManager()?.setNotes(id, notes));
  ipcMain.handle('sessions:contextMenu', (_e, id: string) => getSessionManager()?.showContextMenu(id));

  ipcMain.handle('session:captureScreenshot', (_e, id: string, opts?: { fullPage?: boolean }) => getSessionManager()?.captureScreenshot(id, opts) ?? null);

  ipcMain.handle('testdata:apply', (_e, id: string, template: string) => getSessionManager()?.applyTemplate(id, template));

  ipcMain.handle('security:pageState', (_e, id: string) => getSessionManager()?.getSecurityPageState(id) ?? null);

  ipcMain.handle('sessions:getCookies',      (_e, id: string) => getSessionManager()?.getCookies(id) ?? []);
  ipcMain.handle('sessions:getHistory',      (_e, id: string) => getSessionManager()?.getHistory(id) ?? []);
  ipcMain.handle('sessions:getLoadedDomains', (_e, id: string) => getSessionManager()?.getLoadedDomains(id) ?? []);
  ipcMain.handle('sessions:getLocalStorage', (_e, id: string) => getSessionManager()?.getLocalStorage(id) ?? {});
  ipcMain.handle('sessions:getSessionStorage', (_e, id: string) => getSessionManager()?.getSessionStorage(id) ?? {});
  ipcMain.handle('sessions:getIndexedDB', (_e, id: string) => getSessionManager()?.getIndexedDB(id) ?? {});
  ipcMain.handle('sessions:deleteCookie', (_e, id: string, name: string, domain: string, cookiePath: string, secure: boolean) =>
    getSessionManager()?.deleteCookie(id, name, domain, cookiePath, secure)
  );
  ipcMain.handle('sessions:clearCookies', (_e, id: string) => getSessionManager()?.clearCookies(id));
  ipcMain.handle('sessions:setCookie', (_e, id: string, details: Electron.CookiesSetDetails) =>
    getSessionManager()?.setCookie(id, details)
  );
  ipcMain.handle('sessions:deleteLocalStorageKey', (_e, id: string, key: string) =>
    getSessionManager()?.deleteLocalStorageKey(id, key)
  );
  ipcMain.handle('sessions:setLocalStorageKey', (_e, id: string, key: string, value: string) =>
    getSessionManager()?.setLocalStorageKey(id, key, value)
  );
  ipcMain.handle('sessions:clearLocalStorage', (_e, id: string) => getSessionManager()?.clearLocalStorage(id));

  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(String(text)));
}
