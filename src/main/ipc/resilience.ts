import { ipcMain } from 'electron';
import type { ResilienceRule } from '../resilienceManager';
import type { TabConditions } from '../networkConditions';
import type { AppDeps } from './deps';

/** Resilience rules + per-tab network/CPU throttling IPC. */
export function registerResilienceIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('resilience:getRules',    (_e, id: string) => getSessionManager()?.getResilienceRules(id) ?? []);
  ipcMain.handle('resilience:addRule',     (_e, id: string, rule: ResilienceRule) => getSessionManager()?.addResilienceRule(id, rule));
  ipcMain.handle('resilience:removeRule',  (_e, id: string, ruleId: string) => getSessionManager()?.removeResilienceRule(id, ruleId));
  ipcMain.handle('resilience:toggleRule',  (_e, id: string, ruleId: string, enabled: boolean) => getSessionManager()?.toggleResilienceRule(id, ruleId, enabled));
  ipcMain.handle('resilience:updateRule',  (_e, id: string, ruleId: string, patch: Partial<ResilienceRule>) => getSessionManager()?.updateResilienceRule(id, ruleId, patch));
  ipcMain.handle('resilience:setConditions', (_e, id: string, c: TabConditions) => getSessionManager()?.setConditions(id, c));
  ipcMain.handle('resilience:getConditions', (_e, id: string) => getSessionManager()?.getConditions(id) ?? null);
}
