import { ipcMain } from 'electron';
import type { AppDeps } from './deps';

/** Download manager panel IPC. */
export function registerDownloadsIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('download:list',   (e) => getSessionManager(e)?.listDownloads() ?? []);
  ipcMain.handle('download:open',   (e, id: string) => getSessionManager(e)?.openDownload(id));
  ipcMain.handle('download:reveal', (e, id: string) => getSessionManager(e)?.revealDownload(id));
  ipcMain.handle('download:cancel', (e, id: string) => getSessionManager(e)?.cancelDownload(id));
  ipcMain.handle('download:clear',  (e) => getSessionManager(e)?.clearDownloads());
}
