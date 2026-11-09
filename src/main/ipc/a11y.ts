import { ipcMain } from 'electron';
import type { AppDeps } from './deps';

/** Accessibility tab IPC. */
export function registerA11yIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('a11y:getTree',        (e, id: string) => getSessionManager(e)?.getA11yTree(id) ?? null);
  ipcMain.handle('a11y:setInspect',     (e, id: string, enabled: boolean) => getSessionManager(e)?.setA11yInspect(id, enabled));
  ipcMain.handle('a11y:getViolations',  (e, id: string) => getSessionManager(e)?.getA11yViolations(id) ?? { ok: false, error: 'No session manager' });
  ipcMain.handle('a11y:highlightElement', (e, id: string, selector: string) => getSessionManager(e)?.highlightA11yElement(id, selector) ?? false);
  ipcMain.handle('a11y:getContrastIssues', (e, id: string) => getSessionManager(e)?.getContrastIssues(id) ?? null);
  ipcMain.handle('a11y:highlightNode', (e, id: string, backendDOMNodeId: number) => getSessionManager(e)?.highlightA11yNode(id, backendDOMNodeId) ?? false);
  ipcMain.handle('a11y:getAltLabelIssues', (e, id: string) => getSessionManager(e)?.getAltLabelIssues(id) ?? null);
  ipcMain.handle('a11y:setFocusOverlay', (e, id: string, enabled: boolean) => getSessionManager(e)?.setA11yFocusOverlay(id, enabled) ?? null);
  ipcMain.handle('a11y:detectFocusTrap', (e, id: string) => getSessionManager(e)?.detectA11yFocusTrap(id) ?? null);
}
