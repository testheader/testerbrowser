import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';

let app: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
});

// The bug report modal only opens via a native Help-menu click (main process
// sends 'show:bugreport' to the renderer) — there's no in-page trigger to
// click in a test, so drive it the way the menu does: through the main
// process's own webContents.send.
async function openBugReportModal() {
  const overlay = window.locator('#bugReportOverlay');
  // If a previous test left the modal open, close it first — otherwise the
  // "open" class-check below resolves instantly against the stale state,
  // racing ahead of this invocation's own async reset (screenshot capture
  // then resetForm()) and letting that reset clobber what the test does next.
  if (await overlay.evaluate((el) => el.classList.contains('open'))) {
    await window.keyboard.press('Escape');
    await expect(overlay).not.toHaveClass(/open/, { timeout: 5_000 });
  }
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('show:bugreport');
  });
  await expect(overlay).toHaveClass(/open/, { timeout: 5_000 });
}

test('Escape closes the bug report modal', async () => {
  await openBugReportModal();
  await window.keyboard.press('Escape');
  await expect(window.locator('#bugReportOverlay')).not.toHaveClass(/open/);
});

test('Ctrl+Enter submits the bug report form', async () => {
  await openBugReportModal();
  await window.fill('#bugReportDesc', 'Something broke when I clicked the button.');
  await window.keyboard.press('Control+Enter');

  // No GitHub token is configured in a fresh test profile, so submission
  // fails fast with a known error — proving Ctrl+Enter actually invoked
  // submit (not just that the modal is still open).
  await expect(window.locator('#bugReportMsg')).toContainText('No GitHub token configured', { timeout: 5_000 });
});

test('Ctrl+Enter does nothing when the description is empty', async () => {
  await openBugReportModal();
  await window.fill('#bugReportDesc', '');
  await window.keyboard.press('Control+Enter');
  await expect(window.locator('#bugReportMsg')).toContainText('Please describe what happened', { timeout: 5_000 });
  await expect(window.locator('#bugReportOverlay')).toHaveClass(/open/);
});
