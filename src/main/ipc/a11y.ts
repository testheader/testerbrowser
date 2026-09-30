import { ipcMain } from 'electron';
import type { AppDeps } from './deps';

/** Accessibility tab IPC. */
export function registerA11yIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('a11y:getTree',        (_e, id: string) => getSessionManager()?.getA11yTree(id) ?? null);
  ipcMain.handle('a11y:setInspect',     (_e, id: string, enabled: boolean) => getSessionManager()?.setA11yInspect(id, enabled));
  ipcMain.handle('a11y:getViolations',  (_e, id: string) => getSessionManager()?.getA11yViolations(id) ?? { ok: false, error: 'No session manager' });
  ipcMain.handle('a11y:highlightElement', (_e, id: string, selector: string) => getSessionManager()?.highlightA11yElement(id, selector) ?? false);
  ipcMain.handle('a11y:getContrastIssues', (_e, id: string) => getSessionManager()?.getContrastIssues(id) ?? null);
  ipcMain.handle('a11y:highlightNode', (_e, id: string, backendDOMNodeId: number) => getSessionManager()?.highlightA11yNode(id, backendDOMNodeId) ?? false);
  ipcMain.handle('a11y:getAltLabelIssues', (_e, id: string) => getSessionManager()?.getAltLabelIssues(id) ?? null);
  ipcMain.handle('a11y:setFocusOverlay', (_e, id: string, enabled: boolean) => getSessionManager()?.setA11yFocusOverlay(id, enabled) ?? null);
  ipcMain.handle('a11y:detectFocusTrap', (_e, id: string) => getSessionManager()?.detectA11yFocusTrap(id) ?? null);
}
