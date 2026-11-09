import { ipcMain } from 'electron';
import type { EmulationPatch } from '../emulationManager';
import type { AppDeps } from './deps';

/** Spoof panel (timezone/locale/geolocation/clock/UA/device/media) IPC. */
export function registerEmulationIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('session:setEmulation', (e, id: string, opts: EmulationPatch) => getSessionManager(e)?.setEmulation(id, opts) ?? {});
  ipcMain.handle('session:getEmulation', (e, id: string) => getSessionManager(e)?.getEmulation(id) ?? null);
}
