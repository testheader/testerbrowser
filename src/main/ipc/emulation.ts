import { ipcMain } from 'electron';
import type { EmulationPatch } from '../emulationManager';
import type { AppDeps } from './deps';

/** Spoof panel (timezone/locale/geolocation/clock/UA/device/media) IPC. */
export function registerEmulationIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('session:setEmulation', (_e, id: string, opts: EmulationPatch) => getSessionManager()?.setEmulation(id, opts) ?? {});
  ipcMain.handle('session:getEmulation', (_e, id: string) => getSessionManager()?.getEmulation(id) ?? null);
}
