import { BrowserWindow } from 'electron';

function getHostname(url: string): string {
  try { return new URL(url).hostname || ''; } catch { return ''; }
}

export class PermissionManager {
  private win: BrowserWindow;
  private pendingPermissions = new Map<string, { callback: (granted: boolean) => void; permission: string; partition: string; origin: string }>();
  private grantedPermissions = new Map<string, Set<string>>();

  constructor(win: BrowserWindow) {
    this.win = win;
  }

  attach(ses: Electron.Session, partition: string) {
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      if (permission === 'fullscreen' || permission === 'pointerLock') {
        callback(true);
        return;
      }
      const reqId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const requestingUrl = details?.requestingUrl ?? '';
      let origin = '';
      try { origin = new URL(requestingUrl).origin; } catch {}
      const originLabel = origin || getHostname(requestingUrl) || 'This page';
      this.pendingPermissions.set(reqId, { callback, permission, partition, origin });
      this.win.webContents.send('permission:request', { reqId, permission, origin: originLabel });
    });

    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      return this.grantedPermissions.get(`${partition}|${requestingOrigin}`)?.has(permission) ?? false;
    });
  }

  respond(reqId: string, granted: boolean) {
    const entry = this.pendingPermissions.get(reqId);
    if (!entry) return;
    entry.callback(granted);
    if (granted) {
      const key = `${entry.partition}|${entry.origin}`;
      if (!this.grantedPermissions.has(key)) this.grantedPermissions.set(key, new Set());
      this.grantedPermissions.get(key)!.add(entry.permission);
    }
    this.pendingPermissions.delete(reqId);
  }
}
