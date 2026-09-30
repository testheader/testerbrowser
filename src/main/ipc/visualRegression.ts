import { ipcMain } from 'electron';
import type { AppDeps } from './deps';

/** UI diff (visual regression) saved-baselines IPC (#277). */
export function registerVisualRegressionIpc(deps: AppDeps): void {
  const { getVisualRegressionStore } = deps;

  ipcMain.handle('visualRegression:listBaselines', () => getVisualRegressionStore()?.list() ?? []);
  ipcMain.handle('visualRegression:getBaseline', (_e, id: string) => getVisualRegressionStore()?.get(id) ?? null);
  ipcMain.handle('visualRegression:saveBaseline', (_e, name: string, url: string, b64: string) =>
    getVisualRegressionStore()?.save(name, url, b64) ?? null
  );
  ipcMain.handle('visualRegression:setIgnoreRegions', (_e, id: string, regions: { x: number; y: number; w: number; h: number }[]) =>
    getVisualRegressionStore()?.setIgnoreRegions(id, regions) ?? false
  );
  ipcMain.handle('visualRegression:deleteBaseline', (_e, id: string) => getVisualRegressionStore()?.delete(id) ?? false);
  ipcMain.handle('visualRegression:exportBaseline', (_e, id: string) =>
    getVisualRegressionStore()?.exportBaseline(id) ?? { ok: false, error: 'No store' }
  );
  ipcMain.handle('visualRegression:importBaseline', () =>
    getVisualRegressionStore()?.importBaseline() ?? { ok: false, error: 'No store' }
  );
}
