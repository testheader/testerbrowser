import { ipcMain } from 'electron';
import type { TabConditions } from '../networkConditions';
import type { AppDeps } from './deps';

/** Per-tab network/CPU throttling IPC (the controls live in Spoof › Advanced). */
export function registerThrottleIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('resilience:setConditions', (e, id: string, c: TabConditions) => getSessionManager(e)?.setConditions(id, c));
  ipcMain.handle('resilience:getConditions', (e, id: string) => getSessionManager(e)?.getConditions(id) ?? null);
}
