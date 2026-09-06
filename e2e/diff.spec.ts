import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import { getMainWindow, getTabPage } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

let app: ElectronApplication;
let window: Page;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await electron.launch({
    args: [path.join(__dirname, '..', 'dist', 'main', 'index.js')],
  });
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

test('Diff tab button is present', async () => {
  await expect(window.locator('#consoleTabDiff')).toBeVisible();
});

test('clicking Diff tab shows diffPanel', async () => {
  await window.locator('#consoleTabDiff').click();
  await expect(window.locator('#diffPanel')).toBeVisible();
});

test('diffPanel contains session pickers A and B', async () => {
  await window.locator('#consoleTabDiff').click();
  // initDiff populates pickers on first click; wait briefly
  await window.waitForTimeout(200);
  await expect(window.locator('#diffPickA')).toBeAttached();
  await expect(window.locator('#diffPickB')).toBeAttached();
});

test('diffPanel contains a Run diff button', async () => {
  await window.locator('#consoleTabDiff').click();
  await window.waitForTimeout(200);
  await expect(window.locator('#diffRunBtn')).toBeAttached();
});

test('diffPanel contains a HAR export button', async () => {
  await window.locator('#consoleTabDiff').click();
  await window.waitForTimeout(200);
  await expect(window.locator('#diffHarBtn')).toBeAttached();
});

test('comparing two sessions categorizes matching and unique requests correctly', async () => {
  const urlPath = '/network/status-codes.html';

  const sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const sessionAId = sessions[0].id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), sessionAId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tabA = await getTabPage(app, urlPath);
  await tabA.click('button:text-is("200")');
  await tabA.click('button:text-is("404")');
  await window.waitForTimeout(500);

  await window.click('#newSessionBtn');
  const allSessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const sessionBId = allSessions.find((s: { id: string }) => s.id !== sessionAId).id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), sessionBId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tabB = await getTabPage(app, urlPath, tabA);
  await tabB.click('button:text-is("200")');
  await window.waitForTimeout(500);

  await window.click('#consoleTabDiff');
  await window.selectOption('#diffPickA', sessionAId);
  await window.selectOption('#diffPickB', sessionBId);
  await window.click('#diffRunBtn');

  // Both sessions hit /network/status/200 → same. Only session A hit 404.
  await expect(window.locator('.diff-row.same', { hasText: '/network/status/200' })).toBeVisible();
  await expect(window.locator('.diff-row.only-a', { hasText: '/network/status/404' })).toBeVisible();
});
