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
  // immediately, and rather than waiting for the tab to finish loading a
  // real, possibly-unreachable external URL (this is what the "URL history
  // records the actual navigated URL" acceptance criterion is about).
  await expect.poll(topHistoryUrl).not.toBe(before);
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
  const withScheme = await searchAndGetLastHistoryUrl('https://example.org/path');
  expect(withScheme).toBe('https://example.org/path');

  // Not example.com: urlHistory:add special-cases that exact URL to avoid
  // polluting history with a value other tests use as a dummy placeholder.
  const withoutScheme = await searchAndGetLastHistoryUrl('example.org');
  expect(withoutScheme).toBe('https://example.org');
});
