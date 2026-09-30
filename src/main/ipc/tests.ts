import { ipcMain, dialog } from 'electron';
import fs from 'fs';
import { validateImportedTests } from '../recordingManager';
import { upsertById } from '../upsert';
import type { AppDeps, SavedTest, TestsStore } from './deps';

export interface TestsIpcStores {
  testsStore: TestsStore;
}

/** Saved tests (Record/Playback's "Replay tests" list) persistence + export/import IPC. */
export function registerTestsIpc(deps: AppDeps, stores: TestsIpcStores): void {
  const { getWin, log } = deps;
  const { testsStore } = stores;

  ipcMain.handle('tests:list', () => testsStore.get());
  ipcMain.handle('tests:save', (_e, test: SavedTest) => {
    testsStore.update(all => upsertById(all, test));
  });
  ipcMain.handle('tests:load', (_e, id: string) => testsStore.get().find(t => t.id === id) ?? null);
  ipcMain.handle('tests:delete', (_e, id: string) => testsStore.update(all => all.filter(t => t.id !== id)));

  // #274: mirrors mock:exportRules/mock:importRules (#264) exactly, adapted
  // for SavedTest/TestStep — id/createdAt/updatedAt are stripped on export (the
  // exported file only has what's needed to recreate the test elsewhere) and
  // always minted fresh on import. `id` omitted exports every saved test in
  // one file; passed, exports just that one test — same testerBrowserTests/
  // tests wire shape either way, so import handles both uniformly.
  ipcMain.handle('tests:exportTests', async (_e, id?: string) => {
    const win = getWin();
    if (!win) return { ok: false, error: 'No window' };
    const all = testsStore.get();
    const toExport = id ? all.filter(t => t.id === id) : all;
    if (id && toExport.length === 0) return { ok: false, error: 'Test not found' };
    const result = await dialog.showSaveDialog(win, {
      title: id ? 'Export test' : 'Export all tests',
      defaultPath: id ? 'test.json' : 'tests.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      const exportable = toExport.map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest);
      fs.writeFileSync(result.filePath, JSON.stringify({ testerBrowserTests: 1, tests: exportable }, null, 2));
      log.info('tests', `Tests exported: ${toExport.length}`);
      return { ok: true, path: result.filePath };
    } catch (e) {
      log.warn('tests', 'Tests export failed', { error: String(e) });
      return { ok: false, error: String(e) };
    }
  });

  // #274: valid tests are appended with fresh ids — an import never replaces
  // or reorders what's already saved. A name collision with an existing saved
  // test appends " (imported)" rather than silently overwriting it.
  ipcMain.handle('tests:importTests', async () => {
    const win = getWin();
    if (!win) return { ok: false, error: 'No window' };
    const result = await dialog.showOpenDialog(win, {
      title: 'Import Tests',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };

    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
    } catch {
      return { ok: false, error: 'Not valid JSON' };
    }
    const { tests, skipped, error } = validateImportedTests(json);
    if (error) return { ok: false, error };

    const existingNames = new Set(testsStore.get().map(t => t.name));
    const now = Date.now();
    const imported: SavedTest[] = tests.map((t) => {
      let name = t.name;
      if (existingNames.has(name)) name = `${name} (imported)`;
      existingNames.add(name);
      return {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        name,
        steps: t.steps,
        createdAt: now,
        updatedAt: now,
      };
    });
    if (imported.length > 0) testsStore.update(all => [...all, ...imported]);
    log.info('tests', `Tests imported: ${imported.length} (skipped ${skipped.length})`);
    return { ok: true, imported: imported.length, skipped: skipped.length, firstSkipReason: skipped[0]?.reason };
  });
}
