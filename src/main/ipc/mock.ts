import { ipcMain } from 'electron';
import type { MockRule } from '../mockManager';
import type { AppDeps } from './deps';

/** Mock rules IPC. */
export function registerMockIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('mock:getRules',    (e, id: string) => getSessionManager(e)?.getMockRules(id) ?? []);
  ipcMain.handle('mock:addRule',     (e, id: string, rule: MockRule) => getSessionManager(e)?.addMockRule(id, rule));
  ipcMain.handle('mock:removeRule',  (e, id: string, ruleId: string) => getSessionManager(e)?.removeMockRule(id, ruleId));
  ipcMain.handle('mock:toggleRule',  (e, id: string, ruleId: string, enabled: boolean) => getSessionManager(e)?.toggleMockRule(id, ruleId, enabled));
  ipcMain.handle('mock:updateRule',  (e, id: string, ruleId: string, patch: Partial<MockRule>) => getSessionManager(e)?.updateMockRule(id, ruleId, patch) ?? false);
  ipcMain.handle('mock:moveRule',    (e, id: string, ruleId: string, dir: 'up' | 'down') => getSessionManager(e)?.moveMockRule(id, ruleId, dir));
  ipcMain.handle('mock:exportRules', (e, id: string) => getSessionManager(e)?.exportMockRules(id) ?? { ok: false, error: 'No session manager' });
  ipcMain.handle('mock:importRules', (e, id: string) => getSessionManager(e)?.importMockRules(id) ?? { ok: false, error: 'No session manager' });
}
