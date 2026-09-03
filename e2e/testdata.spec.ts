import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';
import { getMainWindow } from './helpers';

let app: Awaited<ReturnType<typeof electron.launch>>;
let page: Awaited<ReturnType<typeof app.firstWindow>>;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [path.join(__dirname, '..', 'dist', 'main', 'index.js')],
  });
  page = await getMainWindow(app);
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
});

test('testdata overlay exists in DOM', async () => {
  const overlay = page.locator('#testdataOverlay');
  await expect(overlay).toBeAttached();
});

test('testdata overlay is initially hidden', async () => {
  const overlay = page.locator('#testdataOverlay');
  await expect(overlay).not.toHaveClass(/open/);
});

test('testdata input field exists in overlay', async () => {
  const input = page.locator('#testdataInput');
  await expect(input).toBeAttached();
});
