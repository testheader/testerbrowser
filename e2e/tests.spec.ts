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
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(1000);
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

test('Tests tab button exists in console panel', async () => {
  const btn = window.locator('#consoleTabTests');
  await expect(btn).toBeAttached();
});

test('clicking Tests tab shows testsPanel', async () => {
  await window.locator('#consoleTabTests').click();
  await expect(window.locator('#testsPanel')).toBeVisible();
});

test('testsPanel contains Start recording button', async () => {
  await window.locator('#consoleTabTests').click();
  await expect(window.locator('#rpStartBtn')).toBeAttached();
});

test('testsPanel contains test list section', async () => {
  await window.locator('#consoleTabTests').click();
  await expect(window.locator('#rpTestList')).toBeAttached();
});

// ── Real record → save → run cycle ──────────────────────────────────────────

test('recording a fill + click and running it back actually replays successfully', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  await window.fill('#rpTestName', 'fill and click');
  await window.click('#rpStartBtn');

  // Interact on the tab's own page — the recorder captures real DOM events,
  // not synthetic ones injected from the chrome side.
  await tab.fill('[data-testid="rp-input"]', 'Ada');
  await tab.click('[data-testid="rp-btn"]');

  await window.click('#rpStopBtn');
  await window.click('#rpSaveBtn');

  const testItem = window.locator('.rp-test-item', { hasText: 'fill and click' });
  await expect(testItem).toBeVisible();
  // One fill + one click — consecutive keystrokes on the same field coalesce
  // into a single step, so this should be exactly 2, not one-per-keystroke.
  await expect(testItem.locator('.rp-test-meta')).toHaveText('2 steps');

  await testItem.locator('.rp-run-once').click();
  await expect(window.locator('#rpRunStatus')).toHaveText('All steps passed ✓', { timeout: 10_000 });
});
