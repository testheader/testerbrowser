import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

// #367: window.open routing. With no features string it is a tab (as always); with a
// features string it is a popup, which gets its own full TesterBrowser window whose first
// tab keeps window.opener, so OAuth/payment flows that postMessage back to the opener work.

let app: ElectronApplication;
let window: Page;
let fixtures: FixtureServer;

const isChrome = (p: Page) => p.url().endsWith('index.html');
const chromeWindows = () => app.windows().filter(isChrome);

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

async function openOpener(variant: string): Promise<Page> {
  const urlPath = `/windows/popup.html?variant=${variant}`;
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const openerTab = await getTabPage(app, `variant=${variant}`);
  await openerTab.waitForLoadState('load');
  return openerTab;
}

test('window.open with no features opens a tab in the same window, with no opener', async () => {
  const openerTab = await openOpener('plain-tab');
  const windowsBefore = chromeWindows().length;
  const tabsBefore = await window.locator('.tab').count();

  await openerTab.click('text=window.open(\'_blank\')');
  await expect.poll(() => window.locator('.tab').count(), { timeout: 5_000 }).toBe(tabsBefore + 1);

  const childTab = await getTabPage(app, 'windows/child.html', openerTab);
  await childTab.waitForLoadState('load');

  expect(chromeWindows()).toHaveLength(windowsBefore);
  expect(await childTab.evaluate(() => window.opener)).toBeNull();
  expect(await openerTab.evaluate(() => (window as unknown as { __lastMessage?: string }).__lastMessage)).toBeUndefined();
});

test('window.open with a features string opens a new TesterBrowser window whose tab keeps window.opener', async () => {
  const openerTab = await openOpener('popup-window');
  const windowsBefore = chromeWindows().length;
  const pagesBefore = new Set(app.windows()); // earlier tests' child pages are still open

  const opened = app.waitForEvent('window', { predicate: isChrome, timeout: 10_000 });
  await openerTab.click('text=window.open (named + sized)');
  const popupChrome = await opened;
  await popupChrome.waitForLoadState('load');

  expect(chromeWindows()).toHaveLength(windowsBefore + 1);
  await expect(popupChrome.locator('#urlbar')).toBeVisible();
  await expect(popupChrome.locator('.tab')).toHaveCount(1);

  // child.html postMessages 'done' to window.opener once loaded.
  await expect.poll(
    () => openerTab.evaluate(() => (window as unknown as { __lastMessage?: string }).__lastMessage),
    { timeout: 10_000 },
  ).toBe('done');

  const findChild = () => app.windows().find((p) => p.url().includes('windows/child.html') && !pagesBefore.has(p)) ?? null;
  await expect.poll(findChild, { timeout: 10_000 }).not.toBeNull();
  const popupTab = findChild()!;
  expect(await popupTab.evaluate(() => window.opener !== null)).toBe(true);

  // The popup's tab is a normal tab of the popup window: recorded from before its first
  // navigation, and with no way to reach the app's IPC from the page under test.
  type Tab = { id: string };
  const tabs = await popupChrome.evaluate(() => (window as unknown as {
    testerBrowser: { sessions: { list(): Promise<Tab[]> } };
  }).testerBrowser.sessions.list());
  expect(tabs).toHaveLength(1);
  await expect.poll(() => popupChrome.evaluate((id) => (window as unknown as {
    testerBrowser: { recording: { timeline(id: string): Promise<{ url?: string }[]> } };
  }).testerBrowser.recording.timeline(id).then((rows) => JSON.stringify(rows).includes('child.html')), tabs[0].id), { timeout: 10_000 }).toBe(true);
  expect(await popupTab.evaluate(() => Object.keys(window).filter((k) => /testerBrowser|ipcRenderer/.test(k)))).toEqual([]);
});

test('a popup opened with noopener gets a new window but no window.opener', async () => {
  const openerTab = await openOpener('popup-noopener');
  const windowsBefore = chromeWindows().length;
  // The earlier test's popup is still open: pick only the page this click creates.
  const pagesBefore = new Set(app.windows());

  const opened = app.waitForEvent('window', { predicate: isChrome, timeout: 10_000 });
  await openerTab.click('text=window.open (noopener)');
  await opened;

  await expect.poll(() => chromeWindows().length, { timeout: 10_000 }).toBe(windowsBefore + 1);
  const findChild = () => app.windows().find((p) => p.url().includes('windows/child.html') && !pagesBefore.has(p)) ?? null;
  await expect.poll(findChild, { timeout: 10_000 }).not.toBeNull();
  const childTab = findChild()!;
  await childTab.waitForLoadState('load');
  expect(await childTab.evaluate(() => window.opener === null)).toBe(true);
});
