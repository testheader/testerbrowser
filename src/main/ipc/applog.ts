import { ipcMain, shell } from 'electron';
import path from 'path';
import { readLogTail } from '../logTail';
import { getRecentErrors } from '../appLogger';
import { toUpdateLogEntry } from '../debugLogStore';
import type { AppDeps } from './deps';

/** Debug Log console panel tab IPC (main.log tail, structured debug-log.sqlite entries, update-error log). */
export function registerApplogIpc(deps: AppDeps): void {
  const { getLogsDir, getDebugLogStore } = deps;

  ipcMain.handle('applog:tail', (_e, lines: number) => {
    const n = Math.min(Math.max(1, Math.floor(Number(lines)) || 0), 500);
    return readLogTail(getLogsDir(), n);
  });

  ipcMain.handle('applog:revealFolder', () => {
    // silent: shell.showItemInFolder() doesn't report failures in a way there's anything useful to log
    try { shell.showItemInFolder(path.join(getLogsDir(), 'main.log')); } catch {}
  });

  ipcMain.handle('app:debugLog', (_e, afterId?: number) => getDebugLogStore()?.getEntries({ afterId }) ?? getRecentErrors());

  // #228: the updater's own log.error('updater', …) calls (source='updater',
  // ctx carrying status/currentVersion/latestVersion) are the data source,
  // replacing the old update-errors.jsonl file.
  ipcMain.handle('app:getUpdateLog', () =>
    (getDebugLogStore()?.getEntriesBySource('updater') ?? [])
      .filter(e => e.level === 'error')
      .map(toUpdateLogEntry)
  );
}
