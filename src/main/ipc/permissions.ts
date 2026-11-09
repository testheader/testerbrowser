import { ipcMain } from 'electron';
import type { AppDeps } from './deps';

/** Browser permission prompt + Storage tab Permissions section IPC (#276). */
export function registerPermissionsIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('permission:respond', (e, reqId: string, granted: boolean) =>
    getSessionManager(e)?.respondPermission(reqId, granted)
  );
  ipcMain.handle('permission:list', (e, id: string) => getSessionManager(e)?.listPermissions(id) ?? []);
  ipcMain.handle('permission:revoke', (e, id: string, origin: string, permission: string) =>
    getSessionManager(e)?.revokePermission(id, origin, permission) ?? false
  );
}
