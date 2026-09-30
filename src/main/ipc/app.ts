import { ipcMain, app, shell } from 'electron';
import fs from 'fs';
import type { AppDeps, UpdateStatus } from './deps';

export interface AppIpcHooks {
  getUpdateStatus: () => UpdateStatus;
  getLatestVersion: () => string | null;
  // Wraps the exact 'checking' reset + pushUpdateStatus() + autoUpdater.checkForUpdates()
  // sequence index.ts's own autoUpdater setup owns — a no-op for an unpackaged (dev) build.
  checkForUpdatesNow: () => void;
  // Shared by the pill/Settings-triggered restart and #259's idle auto-install.
  restartAndInstall: () => void;
  getCrashLogPath: () => string;
}

/** App version/update-status, external links, error reporting, and crash-log IPC. */
export function registerAppIpc(deps: AppDeps, hooks: AppIpcHooks): void {
  const { recordAppError, rejectUntrustedSender } = deps;
  const { getUpdateStatus, getLatestVersion, checkForUpdatesNow, restartAndInstall, getCrashLogPath } = hooks;

  ipcMain.handle('app:versionInfo', (e) => rejectUntrustedSender(e, 'app:versionInfo') ? null : ({
    current: app.getVersion(), latest: getLatestVersion(), status: getUpdateStatus(), isPackaged: app.isPackaged,
  }));
  ipcMain.handle('app:checkForUpdates', () => checkForUpdatesNow());
  ipcMain.handle('app:restartAndInstall', () => restartAndInstall());
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https:\/\//i.test(url ?? '')) shell.openExternal(url);
  });
  ipcMain.handle('app:reportError', (_e, message: string) => recordAppError(String(message)));

  ipcMain.handle('crash:check', () => {
    const crashLogPath = getCrashLogPath();
    if (!crashLogPath) return null;
    try { return JSON.parse(fs.readFileSync(crashLogPath, 'utf-8')); } catch { return null; }
  });
  ipcMain.handle('crash:clear', () => {
    const crashLogPath = getCrashLogPath();
    // silent: best-effort cleanup; ENOENT here is the common/expected case (already cleared)
    try { if (crashLogPath) fs.unlinkSync(crashLogPath); } catch {}
    return { ok: true };
  });
}
