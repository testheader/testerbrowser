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

// #332: tools that don't fit the strip are listed under a "More (N)" menu.
test('a narrow window shows "More (N)" with the hidden tools, and a hidden tool opens from it', async () => {
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(900, 700); });
  const more = window.locator('#consoleTabsMoreBtn');
  await expect(more).toBeVisible();
  await expect(more).toHaveText(/^More \(\d+\)$/);
  const count = Number((await more.textContent())!.match(/\((\d+)\)/)![1]);

  await more.click();
  const items = window.locator('#consoleTabsMoreMenu .console-more-item');
  await expect(items).toHaveCount(count);

  // The last tool (Debug log) is the first to be pushed out of a narrow strip.
  const last = items.last();
  const label = (await last.textContent())!.trim();
  await last.click();
  await expect(window.locator('#consoleTabsMoreMenu')).toBeHidden();
  await expect(window.locator('.console-tab.active')).toContainText(label.replace(/\d+$/, ''));

  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1400, 900); });
  await expect(more).toBeHidden();
});
