import { ipcMain } from 'electron';
import type { AppDeps } from './deps';

/** Download manager panel IPC. */
export function registerDownloadsIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('download:list',   () => getSessionManager()?.listDownloads() ?? []);
  ipcMain.handle('download:open',   (_e, id: string) => getSessionManager()?.openDownload(id));
  ipcMain.handle('download:reveal', (_e, id: string) => getSessionManager()?.revealDownload(id));
  ipcMain.handle('download:cancel', (_e, id: string) => getSessionManager()?.cancelDownload(id));
  ipcMain.handle('download:clear',  () => getSessionManager()?.clearDownloads());
}
