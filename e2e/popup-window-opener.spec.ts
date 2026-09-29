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

async function setAllowRealPopups(value: boolean) {
  await window.evaluate((v) => (window as unknown as {
    testerBrowser: { settings: { set(patch: { allowRealPopups: boolean }): Promise<unknown> } };
  }).testerBrowser.settings.set({ allowRealPopups: v }), value);
}

test('allowRealPopups off (default): window.open opens as a tracked, isolated tab, so window.opener/postMessage never reaches it (#270)', async () => {
  const urlPath = '/windows/popup.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const openerTab = await getTabPage(app, urlPath);
  await openerTab.waitForLoadState('load');

  const tabCountLocator = window.locator('.tab');
  const before = await tabCountLocator.count();

  await openerTab.click('text=window.open(\'_blank\')');
  await expect.poll(() => tabCountLocator.count(), { timeout: 5_000 }).toBe(before + 1);

  const childTab = await getTabPage(app, 'windows/child.html', openerTab);
  await childTab.waitForLoadState('load');

  // The deny-and-recreate path (today's default) loads the child page into a
  // brand-new, disconnected tab — there was never a real window.open()
  // browsing-context link, so child.html's own `if (window.opener)` guard
  // never fires its postMessage, and this stays unset.
  const lastMessage = await openerTab.evaluate(() => (window as unknown as { __lastMessage?: string }).__lastMessage);
  expect(lastMessage).toBeUndefined();
});

test('allowRealPopups on: window.open opens a real popup that keeps window.opener, so postMessage reaches the opener (#270)', async () => {
  await setAllowRealPopups(true);

  const urlPath = '/windows/popup.html?variant=allow-real-popups';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const openerTab = await getTabPage(app, 'variant=allow-real-popups');
  await openerTab.waitForLoadState('load');

  await openerTab.click('text=window.open(\'_blank\')');

  await expect.poll(
    () => openerTab.evaluate(() => (window as unknown as { __lastMessage?: string }).__lastMessage),
    { timeout: 5_000 },
  ).toBe('done');

  await setAllowRealPopups(false);
});
