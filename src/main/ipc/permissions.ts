import { ipcMain } from 'electron';
import type { AppDeps } from './deps';

/** Browser permission prompt + Storage tab Permissions section IPC (#276). */
export function registerPermissionsIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('permission:respond', (_e, reqId: string, granted: boolean) =>
    getSessionManager()?.respondPermission(reqId, granted)
  );
  ipcMain.handle('permission:list', (_e, id: string) => getSessionManager()?.listPermissions(id) ?? []);
  ipcMain.handle('permission:revoke', (_e, id: string, origin: string, permission: string) =>
    getSessionManager()?.revokePermission(id, origin, permission) ?? false
  );
}
