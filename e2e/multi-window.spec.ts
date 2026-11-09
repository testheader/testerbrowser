import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH, openNewSession } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

// #367: more than one full TesterBrowser window. Tests share one Electron
// instance and build on each other's state, like the rest of the suite.

let app: ElectronApplication;
let a: Page; // first window
let b: Page; // second window
let fixtures: FixtureServer;

const isChrome = (p: Page) => p.url().endsWith('index.html');
const chromeWindows = () => app.windows().filter(isChrome);

type SessionLite = { id: string; name: string };
const listTabs = (w: Page) => w.evaluate(() => (window as unknown as {
  testerBrowser: { sessions: { list(): Promise<SessionLite[]> } };
}).testerBrowser.sessions.list());

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await launchApp(MAIN_PATH);
  a = await getMainWindow(app);
  await a.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

test('Ctrl+N opens a second full window with a single tab', async () => {
  expect(chromeWindows()).toHaveLength(1);

  const opened = app.waitForEvent('window', { predicate: isChrome, timeout: 20_000 });
  await a.keyboard.press('Control+n');
  b = await opened;
  await b.waitForLoadState('load');

  expect(chromeWindows()).toHaveLength(2);
  await expect(b.locator('#urlbar')).toBeVisible();
  await expect(b.locator('.tab')).toHaveCount(1);
});

test('each window lists and creates only its own tabs', async () => {
  const before = (await listTabs(a)).length;
  expect(await listTabs(b)).toHaveLength(1);

  const created = await openNewSession(b);

  expect(await listTabs(b)).toHaveLength(2);
  expect(await listTabs(a)).toHaveLength(before);
  expect((await listTabs(a)).map((s) => s.id)).not.toContain(created.id);
  await expect(a.locator('.tab')).toHaveCount(before);
  await expect(b.locator('.tab')).toHaveCount(2);
});

test('navigating in one window does not change the other', async () => {
  const aTabsBefore = await listTabs(a);
  await b.click('#urlbar');
  await b.fill('#urlbar', fixtures.url('/console/logs.html'));
  await b.press('#urlbar', 'Enter');
  await getTabPage(app, '/console/logs.html');

  await expect(b.locator('#urlbar')).toHaveValue(/console\/logs\.html/);
  expect(await listTabs(a)).toEqual(aTabsBefore);
  await expect(a.locator('#urlbar')).not.toHaveValue(/console\/logs\.html/);
});

test('a theme change in one window reaches the other', async () => {
  const lightInB = () => b.evaluate(() => document.body.classList.contains('light-mode'));
  const before = await lightInB();

  // The toggle cycles system -> light -> dark -> system; click until A's look flips.
  for (let i = 0; i < 3; i++) {
    await a.click('#themeToggleBtn');
    if ((await a.evaluate(() => document.body.classList.contains('light-mode'))) !== before) break;
  }
  const lightInA = await a.evaluate(() => document.body.classList.contains('light-mode'));
  expect(lightInA).not.toBe(before);
  await expect.poll(lightInB, { timeout: 10_000 }).toBe(lightInA);
});

test('a bookmark added in one window shows up in the other without a restart', async () => {
  await a.evaluate(() => (window as unknown as {
    testerBrowser: { bookmarks: { add(url: string, title: string): Promise<unknown> } };
  }).testerBrowser.bookmarks.add('https://bookmark-from-a.test/', 'From A'));

  await expect.poll(() => b.evaluate(() => (window as unknown as {
    testerBrowser: { bookmarks: { list(): Promise<{ url: string }[]> } };
  }).testerBrowser.bookmarks.list().then((l) => l.some((x) => x.url === 'https://bookmark-from-a.test/'))), { timeout: 10_000 }).toBe(true);
});

test('closing the second window leaves the first running', async () => {
  // The window closes under the evaluate call, so its result is never delivered.
  void b.evaluate(() => (window as unknown as {
    testerBrowser: { windowControls: { close(): Promise<void> } };
  }).testerBrowser.windowControls.close()).catch(() => {});

  await expect.poll(() => chromeWindows().length, { timeout: 10_000 }).toBe(1);
  await expect(a.locator('#urlbar')).toBeVisible();
  expect((await listTabs(a)).length).toBeGreaterThan(0);
});
