import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';

let app: ElectronApplication;
let window: Page;
let tab: Page;
const consoleMessages: string[] = [];

test.beforeAll(async () => {
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('domcontentloaded');
  tab = await getTabPage(app, 'newtab.html');
  tab.on('console', (m) => consoleMessages.push(m.text()));
  await tab.reload();
  await tab.waitForSelector('.tile');
});

test.afterAll(async () => {
  await app.close();
});

// #317: the page's own CSP has no 'unsafe-inline', and nothing it needs was blocked.
test('the new-tab page loads under a CSP without unsafe-inline, with its fonts', async () => {
  const csp = await tab.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).not.toContain('unsafe-inline');
  // Favicon fetches that the (unchanged) img-src blocks are expected noise; any
  // script/style/font violation would mean the tightened policy broke the page.
  expect(consoleMessages.filter((m) => /Content Security Policy|Refused to/i.test(m) && !/Loading the image/.test(m))).toEqual([]);

  await expect.poll(() => tab.evaluate(async () => {
    await document.fonts.load('12px "JetBrains Mono"');
    await document.fonts.load('16px lucide');
    return [document.fonts.check('12px "JetBrains Mono"'), document.fonts.check('16px lucide')];
  })).toEqual([true, true]);
  // Styles from the external sheet applied (token-driven body background, not the UA default).
  expect(await tab.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});

test('the page shows a search box naming the engine and a 7-column grid of 96px tiles', async () => {
  await expect(tab.locator('#searchInput')).toHaveAttribute('placeholder', 'Search Google or enter an address');
  const search = await tab.locator('#searchForm').boundingBox();
  expect(Math.round(search!.width)).toBe(520);
  expect(Math.round(search!.height)).toBe(42);
  const cols = await tab.locator('#grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(7);
  expect(Math.round((await tab.locator('.tile').first().boundingBox())!.height)).toBe(96);
  await expect(tab.locator('.tile-add')).toHaveCSS('border-top-style', 'dashed');
});

test('Add site adds a tile and the × on hover removes it', async () => {
  const before = await tab.locator('.tile:not(.tile-add)').count();
  await tab.click('.tile-add');
  await tab.fill('#inputUrl', 'https://example.org');
  await tab.fill('#inputTitle', 'Example Org');
  await tab.click('#btnAdd');
  await expect(tab.locator('.tile:not(.tile-add)')).toHaveCount(before + 1);
  const added = tab.locator('.tile', { hasText: 'Example Org' });
  await expect(added).toBeVisible();

  await added.hover();
  await added.locator('.tile-remove').click();
  await expect(tab.locator('.tile:not(.tile-add)')).toHaveCount(before);
});

test('a tile without a loadable favicon falls back to an initial', async () => {
  await tab.click('.tile-add');
  await tab.fill('#inputUrl', 'https://favicon-fallback.invalid');
  await tab.fill('#inputTitle', 'Zed');
  await tab.click('#btnAdd');
  const tile = tab.locator('.tile', { hasText: 'Zed' });
  await expect(tile.locator('.tile-initial')).toHaveText('Z', { timeout: 10_000 });
  await tile.hover();
  await tile.locator('.tile-remove').click();
});
