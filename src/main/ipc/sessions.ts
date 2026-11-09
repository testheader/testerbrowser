import { ipcMain, clipboard } from 'electron';
import type { EmulationOverrides } from '../emulationManager';
import type { AppDeps } from './deps';

/** Tab lifecycle, navigation, notes, storage panel and misc per-session IPC. */
export function registerSessionsIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('sessions:list',    (e) => getSessionManager(e)?.listSessions() ?? []);
  ipcMain.handle('sessions:create',  (e, name: string, opts) => getSessionManager(e)?.createSession(name, opts).id);
  ipcMain.handle('sessions:switch',  (e, id: string) => getSessionManager(e)?.switchTo(id));
  ipcMain.handle('sessions:destroy', (e, id: string) => getSessionManager(e)?.destroySession(id));
  ipcMain.handle('sessions:navigate',(e, id: string, url: string) => getSessionManager(e)?.navigate(id, url));
  ipcMain.handle('sessions:rename',  (e, id: string, name: string) => getSessionManager(e)?.renameSession(id, name));
  ipcMain.handle('sessions:pin',     (e, id: string, pinned: boolean) => getSessionManager(e)?.pinSession(id, pinned));
  ipcMain.handle('sessions:setTabOrder', (e, order: string[]) => getSessionManager(e)?.setTabOrder(order));
  ipcMain.handle('sessions:reopen',  async (e, opts: {
    name: string; url: string | null; partition: string; color?: string;
    pinned?: boolean; notes?: string; emulation?: EmulationOverrides;
  }) => {
    // Only restore http/https URLs; null/empty falls through to the newtab page
    const startUrl = /^https?:\/\//i.test(opts.url ?? '') ? (opts.url as string) : undefined;
    const sm = getSessionManager(e);
    const s = sm?.createSession(opts.name, { partition: opts.partition, startUrl, color: opts.color, pinned: opts.pinned });
    if (!s) return null;
    if (opts.notes) sm?.setNotes(s.id, opts.notes);
    if (opts.emulation) await sm?.setEmulation(s.id, opts.emulation);
    return s.id;
  });

  ipcMain.handle('sessions:clone', async (e, sourceId: string, newName: string) => {
    const c = await getSessionManager(e)?.cloneSession(sourceId, newName);
    return { id: c?.session.id ?? null, warnings: c?.warnings ?? [] };
  });

  ipcMain.handle('sessions:back',     (e, id: string) => getSessionManager(e)?.back(id));
  ipcMain.handle('sessions:forward',  (e, id: string) => getSessionManager(e)?.forward(id));
  ipcMain.handle('sessions:reload',   (e, id: string) => getSessionManager(e)?.reload(id));
  ipcMain.handle('sessions:stop',     (e, id: string) => getSessionManager(e)?.stop(id));
  ipcMain.handle('sessions:setZoom',  (e, id: string, delta: number) => getSessionManager(e)?.setZoom(id, delta));
  ipcMain.handle('sessions:resetZoom',(e, id: string) => getSessionManager(e)?.resetZoom(id));
  ipcMain.handle('sessions:getZoom',  (e, id: string) => getSessionManager(e)?.getZoom(id) ?? 1);
  ipcMain.handle('devtools:toggle',   (e, id: string) => getSessionManager(e)?.toggleDevTools(id));

  ipcMain.handle('find:start', (e, id: string, text: string, forward: boolean, findNext: boolean) =>
    getSessionManager(e)?.findInPage(id, text, forward, findNext)
  );
  ipcMain.handle('find:stop', (e, id: string) => getSessionManager(e)?.stopFind(id));

  ipcMain.handle('sessions:notes:get', (e, id: string) => getSessionManager(e)?.getNotes(id) ?? '');
  ipcMain.handle('sessions:notes:set', (e, id: string, notes: string) => getSessionManager(e)?.setNotes(id, notes));
  ipcMain.handle('sessions:contextMenu', (e, id: string) => getSessionManager(e)?.showContextMenu(id));

  ipcMain.handle('session:captureScreenshot', (e, id: string, opts?: { fullPage?: boolean }) => getSessionManager(e)?.captureScreenshot(id, opts) ?? null);

  ipcMain.handle('testdata:apply', (e, id: string, template: string) => getSessionManager(e)?.applyTemplate(id, template));

  ipcMain.handle('security:pageState', (e, id: string) => getSessionManager(e)?.getSecurityPageState(id) ?? null);

  ipcMain.handle('sessions:getCookies',      (e, id: string) => getSessionManager(e)?.getCookies(id) ?? []);
  ipcMain.handle('sessions:getHistory',      (e, id: string) => getSessionManager(e)?.getHistory(id) ?? []);
  ipcMain.handle('sessions:getLoadedDomains', (e, id: string) => getSessionManager(e)?.getLoadedDomains(id) ?? []);
  ipcMain.handle('sessions:getLocalStorage', (e, id: string) => getSessionManager(e)?.getLocalStorage(id) ?? {});
  ipcMain.handle('sessions:getSessionStorage', (e, id: string) => getSessionManager(e)?.getSessionStorage(id) ?? {});
  ipcMain.handle('sessions:getIndexedDB', (e, id: string) => getSessionManager(e)?.getIndexedDB(id) ?? {});
  ipcMain.handle('sessions:deleteCookie', (e, id: string, name: string, domain: string, cookiePath: string, secure: boolean) =>
    getSessionManager(e)?.deleteCookie(id, name, domain, cookiePath, secure)
  );
  ipcMain.handle('sessions:clearCookies', (e, id: string) => getSessionManager(e)?.clearCookies(id));
  ipcMain.handle('sessions:setCookie', (e, id: string, details: Electron.CookiesSetDetails) =>
    getSessionManager(e)?.setCookie(id, details)
  );
  ipcMain.handle('sessions:deleteLocalStorageKey', (e, id: string, key: string) =>
    getSessionManager(e)?.deleteLocalStorageKey(id, key)
  );
  ipcMain.handle('sessions:setLocalStorageKey', (e, id: string, key: string, value: string) =>
    getSessionManager(e)?.setLocalStorageKey(id, key, value)
  );
  ipcMain.handle('sessions:clearLocalStorage', (e, id: string) => getSessionManager(e)?.clearLocalStorage(id));

  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(String(text)));
}
