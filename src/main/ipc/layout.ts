import { ipcMain } from 'electron';
import type { AppDeps } from './deps';

/** BrowserView layout (console panel height, page overlay for dropdowns) and window-chrome controls IPC. */
export function registerLayoutIpc(deps: AppDeps): void {
  const { getSessionManager, getWin } = deps;

  ipcMain.handle('layout:setConsoleHeight',(_e, h: number) => getSessionManager()?.setConsoleHeight(h));
  ipcMain.handle('layout:setTopBarHeight', (_e, h: number) => getSessionManager()?.setTopBarHeight(h));
  ipcMain.handle('layout:setViewerVisible',(_e, v: boolean) => getSessionManager()?.setViewerVisible(v));
  ipcMain.handle('layout:setRightPanelWidth', (_e, w: number) => getSessionManager()?.setRightPanelWidth(w));
  ipcMain.handle('layout:beginPageOverlay', () => getSessionManager()?.beginPageOverlay() ?? null);
  ipcMain.handle('layout:endPageOverlay', () => getSessionManager()?.endPageOverlay());

  ipcMain.handle('window:minimize',    () => getWin()?.minimize());
  ipcMain.handle('window:maximize',    () => { const w = getWin(); if (w?.isMaximized()) w.unmaximize(); else w?.maximize(); });
  ipcMain.handle('window:close',       () => getWin()?.close());
  ipcMain.handle('window:isMaximized', () => getWin()?.isMaximized() ?? false);
}
