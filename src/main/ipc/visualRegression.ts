import { ipcMain } from 'electron';
import type { AppDeps } from './deps';

/** UI diff (visual regression) saved-baselines IPC (#277). */
export function registerVisualRegressionIpc(deps: AppDeps): void {
  const { getVisualRegressionStore } = deps;

  ipcMain.handle('visualRegression:listBaselines', (e) => getVisualRegressionStore(e)?.list() ?? []);
  ipcMain.handle('visualRegression:getBaseline', (e, id: string) => getVisualRegressionStore(e)?.get(id) ?? null);
  ipcMain.handle('visualRegression:saveBaseline', (e, name: string, url: string, b64: string) =>
    getVisualRegressionStore(e)?.save(name, url, b64) ?? null
  );
  ipcMain.handle('visualRegression:setIgnoreRegions', (e, id: string, regions: { x: number; y: number; w: number; h: number }[]) =>
    getVisualRegressionStore(e)?.setIgnoreRegions(id, regions) ?? false
  );
  ipcMain.handle('visualRegression:deleteBaseline', (e, id: string) => getVisualRegressionStore(e)?.delete(id) ?? false);
  ipcMain.handle('visualRegression:exportBaseline', (e, id: string) =>
    getVisualRegressionStore(e)?.exportBaseline(id) ?? { ok: false, error: 'No store' }
  );
  ipcMain.handle('visualRegression:importBaseline', (e) =>
    getVisualRegressionStore(e)?.importBaseline() ?? { ok: false, error: 'No store' }
  );
  ipcMain.handle('visualRegression:exportDiff', (e, pngB64: string, suggestedName: string) =>
    getVisualRegressionStore(e)?.exportDiff(pngB64, suggestedName) ?? { ok: false, error: 'No store' }
  );
}
