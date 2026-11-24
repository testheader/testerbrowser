import { ipcMain } from 'electron';
import { stripSnapshots, type Rule } from '../rules';
import type { AppDeps } from './deps';

/** Rules IPC (#370): one ordered list per session partition — mock, fail, delay, hang, race, rewrite. */
export function registerRulesIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('rules:getRules',    (e, id: string) => stripSnapshots(getSessionManager(e)?.getRules(id) ?? []));
  ipcMain.handle('rules:addRule',     (e, id: string, rule: Rule) => getSessionManager(e)?.addRule(id, rule));
  ipcMain.handle('rules:removeRule',  (e, id: string, ruleId: string) => getSessionManager(e)?.removeRule(id, ruleId));
  ipcMain.handle('rules:toggleRule',  (e, id: string, ruleId: string, enabled: boolean) => getSessionManager(e)?.toggleRule(id, ruleId, enabled));
  ipcMain.handle('rules:updateRule',  (e, id: string, ruleId: string, patch: Partial<Rule>) => getSessionManager(e)?.updateRule(id, ruleId, patch) ?? false);
  ipcMain.handle('rules:moveRule',    (e, id: string, ruleId: string, dir: 'up' | 'down') => getSessionManager(e)?.moveRule(id, ruleId, dir));
  ipcMain.handle('rules:reorderRule', (e, id: string, ruleId: string, toIndex: number) => getSessionManager(e)?.reorderRule(id, ruleId, toIndex));
  ipcMain.handle('rules:exportRules', (e, id: string) => getSessionManager(e)?.exportRules(id) ?? { ok: false, error: 'No session manager' });
  ipcMain.handle('rules:importRules', (e, id: string) => getSessionManager(e)?.importRules(id) ?? { ok: false, error: 'No session manager' });
}
