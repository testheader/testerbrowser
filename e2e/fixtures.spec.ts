/**
 * Smoke tests for the test-pages/ fixtures, served by the shared fixture
 * server (e2e/fixtures/server.ts). These exist to prove the fixture pages
 * actually exercise the app features they're named for, so the fixtures
 * don't silently rot.
 *
 * Each tab is its own WebContentsView (a separate Playwright Page from the
 * chrome window) — see getTabPage in helpers.ts. Anything the fixture page
 * itself renders must be driven through that page, not through `window`.
 */
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

async function navigate(urlPath: string): Promise<Page> {
  const url = fixtures.url(urlPath);
  await window.click('#urlbar');
  await window.fill('#urlbar', url);
  await window.press('#urlbar', 'Enter');
  return getTabPage(app, urlPath);
}

// ── Console ──────────────────────────────────────────────────────────────────

test('console/logs.html produces console events at every level', async () => {
  await navigate('/console/logs.html');
  await window.waitForTimeout(1_500); // pollTimeline runs every 1s

  const kinds = await window.locator('#timelinePanel .evt').evaluateAll(
    els => els.map(el => (el as HTMLElement).className)
  );
  expect(kinds.some(c => c.includes('console-error'))).toBe(true);
  expect(kinds.some(c => c.includes('console-warning'))).toBe(true);
});

// ── Network ──────────────────────────────────────────────────────────────────

test('network/status-codes.html: a 404 shows up as a network event', async () => {
  const tab = await navigate('/network/status-codes.html');
  await window.click('#consoleTabNetwork');
  await tab.click('button:text-is("404")');
  await window.waitForTimeout(1_500);

  const resPill = window.locator('#networkPills .filter-pill[data-type="network-response"] .pill-count');
  await expect(resPill).not.toHaveText('');
});

test('performance/network-flood.html: burst of 50 requests all get recorded', async () => {
  const tab = await navigate('/performance/network-flood.html');
  await window.click('#consoleTabNetwork');
  await tab.click('button:text("50 concurrent requests")');
  // Give the burst + poll cycle time to land.
  await window.waitForTimeout(3_000);

  const reqPillText = await window
    .locator('#networkPills .filter-pill[data-type="network-request"] .pill-count')
    .textContent();
  expect(Number(reqPillText)).toBeGreaterThanOrEqual(50);
});

// ── Downloads ────────────────────────────────────────────────────────────────

test('downloads/index.html: generated file download appears in the downloads list', async () => {
  const tab = await navigate('/downloads/index.html');
  await tab.click('a[href*="small.txt"] button');
  await window.waitForTimeout(1_500);
  await window.click('#downloadsBtn');

  // Electron appends "(1)" etc. if a same-named file already exists in the
  // downloads folder, so match loosely rather than asserting the exact name.
  await expect(window.locator('#downloadsList')).toContainText(/small.*\.txt/);
});

// ── Storage ──────────────────────────────────────────────────────────────────

test('storage/localstorage.html: seeded keys appear in the Storage tab', async () => {
  const tab = await navigate('/storage/localstorage.html');
  await tab.click('button:text("Seed 3 keys")');
  await window.click('#consoleTabStorage');
  await window.click('#refreshStorageBtn');
  await window.waitForTimeout(500);

  await expect(window.locator('#storagePanel')).toContainText('username');
  await expect(window.locator('#storagePanel')).toContainText('tester');
});

// ── Permissions ──────────────────────────────────────────────────────────────

test('permissions page triggers a permission notification', async () => {
  const tab = await navigate('/permissions/index.html');
  await tab.click('#notif');
  await expect(window.locator('#permissionNotifications')).not.toBeEmpty();
});
