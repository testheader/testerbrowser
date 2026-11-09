import { ipcMain } from 'electron';
import type { ResilienceRule } from '../resilienceManager';
import type { TabConditions } from '../networkConditions';
import type { AppDeps } from './deps';

/** Resilience rules + per-tab network/CPU throttling IPC. */
export function registerResilienceIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('resilience:getRules',    (e, id: string) => getSessionManager(e)?.getResilienceRules(id) ?? []);
  ipcMain.handle('resilience:addRule',     (e, id: string, rule: ResilienceRule) => getSessionManager(e)?.addResilienceRule(id, rule));
  ipcMain.handle('resilience:removeRule',  (e, id: string, ruleId: string) => getSessionManager(e)?.removeResilienceRule(id, ruleId));
  ipcMain.handle('resilience:toggleRule',  (e, id: string, ruleId: string, enabled: boolean) => getSessionManager(e)?.toggleResilienceRule(id, ruleId, enabled));
  ipcMain.handle('resilience:updateRule',  (e, id: string, ruleId: string, patch: Partial<ResilienceRule>) => getSessionManager(e)?.updateResilienceRule(id, ruleId, patch));
  ipcMain.handle('resilience:setConditions', (e, id: string, c: TabConditions) => getSessionManager(e)?.setConditions(id, c));
  ipcMain.handle('resilience:getConditions', (e, id: string) => getSessionManager(e)?.getConditions(id) ?? null);
}
