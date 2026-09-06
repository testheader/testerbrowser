/**
 * #15 — dialog & popup management. A page's alert()/confirm()/prompt() are
 * overridden from the tab preload (preload/newtab.ts) to route through a
 * floating, non-blocking notification (renderer/dialogs.js) instead of
 * Chromium's default window-modal dialog, and window.open() is intercepted
 * in sessionManager.ts to open a new tab rather than a real popup window —
 * neither should ever freeze the rest of the browser chrome.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

let app: ElectronApplication;
let window: Page;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

test('alert() shows a floating notification and does not block the toolbar or other tabs', async () => {
  await window.click('#newSessionBtn');
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/'));
  await window.press('#urlbar', 'Enter');
  const tabPage = await getTabPage(app, '127.0.0.1');
  await tabPage.waitForLoadState('domcontentloaded');

  const alertPromise = tabPage.evaluate(() => { (window as any).alert('hello from the page'); return 'alert-returned'; });

  await expect(window.locator('.dlg-notif .dlg-msg')).toHaveText('hello from the page');

  // The rest of the chrome must stay fully interactive while alert() is
  // pending — clicking the "+" button must still work, proving the toolbar
  // isn't frozen by a native window-modal dialog.
  await window.click('#newSessionBtn');
  const sessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  expect(sessions.length).toBeGreaterThanOrEqual(3);

  await window.locator('.dlg-notif .dlg-ok').click();
  await expect(alertPromise).resolves.toBe('alert-returned');
  await expect(window.locator('.dlg-notif')).toHaveCount(0);
});

test('confirm() returns true/false based on which button is clicked, without blocking the chrome', async () => {
  const tabPage = await getTabPage(app, '127.0.0.1');

  const okPromise = tabPage.evaluate(() => (window as any).confirm('proceed?'));
  await expect(window.locator('.dlg-notif .dlg-msg')).toHaveText('proceed?');
  await window.click('#newSessionBtn'); // chrome still responsive
  await window.locator('.dlg-notif .dlg-ok').click();
  await expect(okPromise).resolves.toBe(true);

  const cancelPromise = tabPage.evaluate(() => (window as any).confirm('proceed again?'));
  await expect(window.locator('.dlg-notif .dlg-msg')).toHaveText('proceed again?');
  await window.locator('.dlg-notif .dlg-cancel').click();
  await expect(cancelPromise).resolves.toBe(false);
});

test('prompt() returns the typed value, or null on cancel', async () => {
  const tabPage = await getTabPage(app, '127.0.0.1');

  const valuePromise = tabPage.evaluate(() => (window as any).prompt('your name?', 'default'));
  const input = window.locator('.dlg-notif .dlg-input');
  await expect(input).toHaveValue('default');
  await input.fill('Ada');
  await window.locator('.dlg-notif .dlg-ok').click();
  await expect(valuePromise).resolves.toBe('Ada');

  const nullPromise = tabPage.evaluate(() => (window as any).prompt('again?'));
  await expect(window.locator('.dlg-notif')).toBeVisible();
  await window.locator('.dlg-notif .dlg-cancel').click();
  await expect(nullPromise).resolves.toBeNull();
});

test('window.open() opens a new tab instead of a blocking native popup', async () => {
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/windows/popup.html'));
  await window.press('#urlbar', 'Enter');
  const popupPage = await getTabPage(app, '/windows/popup.html');
  await popupPage.waitForLoadState('domcontentloaded');

  const before: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  await popupPage.click('text=window.open(\'_blank\')');

  await expect.poll(async () => {
    const after: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
    return after.length;
  }).toBe(before.length + 1);

  // The chrome is still perfectly usable — no native popup window blocked it.
  await expect(window.locator('#tabs')).toBeVisible();
  await window.click('#newSessionBtn');
});
