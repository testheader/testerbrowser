import { ipcMain } from 'electron';
import type { AppDeps } from './deps';

/** BrowserView layout (console panel height, page overlay for dropdowns) and window-chrome controls IPC. */
export function registerLayoutIpc(deps: AppDeps): void {
  const { getSessionManager, getWin, openWindow } = deps;

  ipcMain.handle('layout:setConsoleHeight',(e, h: number) => getSessionManager(e)?.setConsoleHeight(h));
  ipcMain.handle('layout:setTopBarHeight', (e, h: number) => getSessionManager(e)?.setTopBarHeight(h));
  ipcMain.handle('layout:setViewerVisible',(e, v: boolean) => getSessionManager(e)?.setViewerVisible(v));
  ipcMain.handle('layout:setRightPanelWidth', (e, w: number) => getSessionManager(e)?.setRightPanelWidth(w));
  ipcMain.handle('layout:beginPageOverlay', (e) => getSessionManager(e)?.beginPageOverlay() ?? null);
  ipcMain.handle('layout:endPageOverlay', (e) => getSessionManager(e)?.endPageOverlay());

  ipcMain.handle('window:new',         () => openWindow());
  ipcMain.handle('window:minimize',    (e) => getWin(e)?.minimize());
  ipcMain.handle('window:maximize',    (e) => { const w = getWin(e); if (w?.isMaximized()) w.unmaximize(); else w?.maximize(); });
  ipcMain.handle('window:close',       (e) => getWin(e)?.close());
  ipcMain.handle('window:isMaximized', (e) => getWin(e)?.isMaximized() ?? false);
}
