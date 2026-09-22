import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _electron as electron } from '@playwright/test';
import { getMainWindow, getActiveViewBounds, MAIN_PATH } from './helpers';

// launchApp() (helpers.ts) always starts from a fresh, sentinel-free userData
// dir, so there's nothing for src/main/index.ts's crash detection to find on
// launch. Simulate "the previous session crashed" by writing a
// running.sentinel file into a fresh userData dir *before* launching — the
// same file app.whenReady() itself writes on every normal startup and only
// fails to clean up when the app doesn't exit normally.
async function launchWithSimulatedCrash(): Promise<ElectronApplication> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-e2e-crash-'));
  fs.writeFileSync(
    path.join(userDataDir, 'running.sentinel'),
    JSON.stringify({ startedAt: new Date(Date.now() - 60_000).toISOString() }),
  );
  return electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
}

test.describe('crash modal visibility', () => {
  let app: ElectronApplication;
  let window: Page;

  test.beforeAll(async () => {
    app = await launchWithSimulatedCrash();
    window = await getMainWindow(app);
    await window.waitForLoadState('load');
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('crash modal shows fully visible over the restored tab view, not hidden behind it', async () => {
    await expect(window.locator('#crashReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });
    // setViewerVisible(false) removes the active tab's WebContentsView from
    // the window's contentView tree entirely — getActiveViewBounds() finds
    // no child view while it's detached, proving the modal isn't rendering
    // hidden underneath it.
    expect(await getActiveViewBounds(app)).toBeNull();
  });

  test('Dismiss hides the modal, clears the crash log and restores the tab view', async () => {
    await window.click('#crashReportDismissBtn');
    await expect(window.locator('#crashReportOverlay')).not.toHaveClass(/open/);

    await expect(async () => {
      expect(await getActiveViewBounds(app)).not.toBeNull();
    }).toPass({ timeout: 5_000 });

    const log = await window.evaluate(() => (window as any).testerBrowser.crash.check());
    expect(log).toBeNull();
  });
});

test.describe('crash modal file-a-bug-report handoff', () => {
  let app: ElectronApplication;
  let window: Page;

  test.beforeAll(async () => {
    app = await launchWithSimulatedCrash();
    window = await getMainWindow(app);
    await window.waitForLoadState('load');
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('"File a bug report…" opens the bug report form pre-filled with the crash timestamp', async () => {
    await expect(window.locator('#crashReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });
    const timestampText = await window.locator('#crashReportTimestamp').textContent();

    await window.click('#crashReportFileBtn');

    await expect(window.locator('#crashReportOverlay')).not.toHaveClass(/open/);
    await expect(window.locator('#bugReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });
    // #bugReportDesc is a textarea filled via .value = ..., not markup — assert
    // against its value, not textContent (which toContainText would check).
    await expect(window.locator('#bugReportDesc')).toHaveValue(/TesterBrowser crashed unexpectedly\./, { timeout: 5_000 });
    if (timestampText) {
      await expect(window.locator('#bugReportDesc')).toHaveValue(new RegExp(timestampText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});
