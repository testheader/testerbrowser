import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';

let app: Awaited<ReturnType<typeof electron.launch>>;
let page: Awaited<ReturnType<typeof app.firstWindow>>;

test.beforeAll(async () => {
  app = await launchApp(MAIN_PATH);
  page = await getMainWindow(app);
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
});

// autoUpdater only runs when app.isPackaged, which an e2e build isn't — drive
// the renderer directly by sending the same 'update:status' message the main
// process's pushUpdateStatus() would (see #230's ticket test plan).
async function sendUpdateStatus(status: string, latest: string | null) {
  await app.evaluate(
    ({ BrowserWindow }, data) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('update:status', data);
    },
    { status, current: '1.0.0', latest }
  );
}

test('the update-ready pill appears with the target version once status is "downloaded"', async () => {
  await sendUpdateStatus('downloaded', '9.9.9');
  await expect(page.locator('#updateReadyBtn')).toBeVisible();
  await expect(page.locator('#updateReadyBtn')).toContainText('9.9.9');

  await sendUpdateStatus('not-available', '1.0.0');
  await expect(page.locator('#updateReadyBtn')).toBeHidden();
});

test('available-manual never shows the pill', async () => {
  await sendUpdateStatus('available-manual', '9.9.9');
  await expect(page.locator('#updateReadyBtn')).toBeHidden();

  await sendUpdateStatus('not-available', '1.0.0');
});

test('clicking the pill with no temp tabs open restarts immediately, without a confirm popover', async () => {
  // Stub app:restartAndInstall so a real click-through doesn't quit this
  // Electron instance mid test-run — per the ticket's own suggested technique.
  await app.evaluate(({ ipcMain }) => {
    (globalThis as any).__restartAndInstallCalls = 0;
    ipcMain.removeHandler('app:restartAndInstall');
    ipcMain.handle('app:restartAndInstall', () => {
      (globalThis as any).__restartAndInstallCalls++;
    });
  });

  await sendUpdateStatus('downloaded', '9.9.9');
  await expect(page.locator('#updateReadyBtn')).toBeVisible();

  await page.click('#updateReadyBtn');

  await expect(async () => {
    const calls = await app.evaluate(() => (globalThis as any).__restartAndInstallCalls);
    expect(calls).toBe(1);
  }).toPass({ timeout: 5_000 });
  await expect(page.locator('#updateReadyPopover')).toBeHidden();
});

test('clicking the pill with a temp tab open shows a confirm popover; Cancel does not restart, Restart now does', async () => {
  await app.evaluate(({ ipcMain }) => {
    (globalThis as any).__restartAndInstallCalls = 0;
    ipcMain.removeHandler('app:restartAndInstall');
    ipcMain.handle('app:restartAndInstall', () => {
      (globalThis as any).__restartAndInstallCalls++;
    });
  });

  // Open a temp tab via the app menu ("New temporary tab").
  await page.click('#appName');
  await page.click('#appMenuNewTemp');

  await sendUpdateStatus('downloaded', '9.9.9');
  await expect(page.locator('#updateReadyBtn')).toBeVisible();

  await page.click('#updateReadyBtn');
  await expect(page.locator('#updateReadyPopover')).toBeVisible();
  await expect(page.locator('#updateReadyPopoverText')).toContainText('1 temporary tab');

  await page.click('#updateReadyCancelBtn');
  await expect(page.locator('#updateReadyPopover')).toBeHidden();
  let calls = await app.evaluate(() => (globalThis as any).__restartAndInstallCalls);
  expect(calls).toBe(0);

  await page.click('#updateReadyBtn');
  await expect(page.locator('#updateReadyPopover')).toBeVisible();
  await page.click('#updateReadyConfirmBtn');

  await expect(async () => {
    calls = await app.evaluate(() => (globalThis as any).__restartAndInstallCalls);
    expect(calls).toBe(1);
  }).toPass({ timeout: 5_000 });
  await expect(page.locator('#updateReadyPopover')).toBeHidden();
});
