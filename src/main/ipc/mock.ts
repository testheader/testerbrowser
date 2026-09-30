import { ipcMain } from 'electron';
import type { MockRule } from '../mockManager';
import type { AppDeps } from './deps';

/** Mock rules IPC. */
export function registerMockIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('mock:getRules',    (_e, id: string) => getSessionManager()?.getMockRules(id) ?? []);
  ipcMain.handle('mock:addRule',     (_e, id: string, rule: MockRule) => getSessionManager()?.addMockRule(id, rule));
  ipcMain.handle('mock:removeRule',  (_e, id: string, ruleId: string) => getSessionManager()?.removeMockRule(id, ruleId));
  ipcMain.handle('mock:toggleRule',  (_e, id: string, ruleId: string, enabled: boolean) => getSessionManager()?.toggleMockRule(id, ruleId, enabled));
  ipcMain.handle('mock:updateRule',  (_e, id: string, ruleId: string, patch: Partial<MockRule>) => getSessionManager()?.updateMockRule(id, ruleId, patch) ?? false);
  ipcMain.handle('mock:moveRule',    (_e, id: string, ruleId: string, dir: 'up' | 'down') => getSessionManager()?.moveMockRule(id, ruleId, dir));
  ipcMain.handle('mock:exportRules', (_e, id: string) => getSessionManager()?.exportMockRules(id) ?? { ok: false, error: 'No session manager' });
  ipcMain.handle('mock:importRules', (_e, id: string) => getSessionManager()?.importMockRules(id) ?? { ok: false, error: 'No session manager' });
}
