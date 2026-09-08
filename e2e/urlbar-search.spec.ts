import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';
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

async function setSearchEngine(engine: 'google' | 'duckduckgo') {
  await window.click('#appName');
  await window.click('#appMenuSettings');
  await expect(window.locator('#settingsOverlay')).toHaveClass(/open/);
  await window.selectOption('#searchEngineSelect', engine);
  await window.click('#settingsCloseXBtn');
  await expect(window.locator('#settingsOverlay')).not.toHaveClass(/open/);
}

async function topHistoryUrl(): Promise<string | undefined> {
  return (await window.evaluate(() => (window as any).testerBrowser.urlHistory.get()))[0];
}

async function searchAndGetLastHistoryUrl(query: string): Promise<string | undefined> {
  const before = await topHistoryUrl();
  await window.click('#urlbar');
  await window.fill('#urlbar', query);
  await window.press('#urlbar', 'Enter');
  // The urlbar's Enter handler resolves testerBrowser.sessions.navigate()
  // and urlHistory.add() asynchronously, after Playwright's press() already
  // returns — poll for the top entry to change rather than reading it
  // immediately. sessions.navigate() itself doesn't await the page actually
  // loading (a fire-and-forget webContents.loadURL()), so this is normally
  // fast regardless of target reachability.
  await expect.poll(topHistoryUrl, { timeout: 10_000 }).not.toBe(before);
  return topHistoryUrl();
}

test('default search engine is Google, and a plain search term searches instead of navigating', async () => {
  await window.click('#appName');
  await window.click('#appMenuSettings');
  await expect(window.locator('#searchEngineSelect')).toHaveValue('google');
  await window.click('#settingsCloseXBtn');

  const url = await searchAndGetLastHistoryUrl('weather today');
  expect(url).toBe('https://www.google.com/search?q=weather%20today');
});

test('switching the default engine to DuckDuckGo changes what a search term navigates to', async () => {
  await setSearchEngine('duckduckgo');

  const url = await searchAndGetLastHistoryUrl('cats');
  expect(url).toBe('https://duckduckgo.com/?q=cats');

  await setSearchEngine('google'); // restore default for any later tests
});

test('an actual URL still navigates directly, with or without a scheme', async () => {
  // sessions.navigate() is fire-and-forget (searchAndGetLastHistoryUrl's own
  // comment above), so the target doesn't need to actually load — but it
  // used to be a real external site (https://example.org), which repeatedly
  // flaked on the Windows CI runner (#150's needs-fix history). The local
  // fixture server exercises the same "URL vs. search term" logic while
  // keeping this test hermetic, like the rest of the e2e suite.
  const target = fixtures.url('/network/status-codes.html');
  const withScheme = await searchAndGetLastHistoryUrl(target);
  expect(withScheme).toBe(target);

  const withoutScheme = await searchAndGetLastHistoryUrl(`127.0.0.1:${fixtures.port}/network/status-codes.html`);
  expect(withoutScheme).toBe(`https://127.0.0.1:${fixtures.port}/network/status-codes.html`);
});
