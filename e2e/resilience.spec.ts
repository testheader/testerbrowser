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

test('Resilience tab button exists', async () => {
  const tab = window.locator('#consoleTabResilience');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveText('Resilience');
});

test('clicking Resilience tab shows resiliencePanel', async () => {
  await window.locator('#consoleTabResilience').click();
  const panel = window.locator('#resiliencePanel');
  await expect(panel).toBeVisible();
});

test('resilience panel renders add-rule form on first click', async () => {
  await window.locator('#consoleTabResilience').click();
  await window.waitForSelector('#resForm', { timeout: 3000 });
  await expect(window.locator('#resType')).toBeVisible();
  await expect(window.locator('#resUrl')).toBeVisible();
});

test('resilience panel shows empty state initially', async () => {
  await window.locator('#consoleTabResilience').click();
  await window.waitForSelector('#resEmpty', { timeout: 3000 });
  await expect(window.locator('#resEmpty')).toBeVisible();
});

test('a 100% error500 rule actually fails a matching fetch, and hits increments', async () => {
  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabResilience');
  await window.selectOption('#resType', 'error500');
  await window.fill('#resUrl', '*/api/resilience-target');
  await window.fill('#resProb', '100');
  await window.click('.res-add-btn');
  await expect(window.locator('.res-rule-row')).toBeVisible();

  await tab.fill('#apiPath', '/api/resilience-target');
  await tab.click('#apiFetchBtn');
  await expect(tab.locator('#apiOut')).toContainText('"status":500', { timeout: 5_000 });

  await expect(window.locator('.res-hits-badge')).toHaveText('Hits: 1', { timeout: 3_000 });

  // The RESILIENCE flag should show on the request row, not just the response
  // row — the request is recorded before Fetch.requestPaused tags it, so this
  // also exercises the retroactive tag-patch onto the already-recorded row.
  await window.click('#consoleTabNetwork');
  const requestRow = window.locator('.evt.network-request', { hasText: '/api/resilience-target' });
  await expect(requestRow.locator('.evt-badge-resilience')).toBeVisible({ timeout: 5_000 });
});

test('an existing rule can be edited in place', async () => {
  await window.click('#consoleTabResilience');
  const row = window.locator('.res-rule-row').first();
  await row.locator('.res-edit-btn').click();

  const editRow = window.locator('.res-rule-row-editing');
  await expect(editRow).toBeVisible();
  await editRow.locator('.res-edit-prob').fill('42');
  await editRow.locator('.res-save-btn').click();

  await expect(window.locator('.res-rule-row').first().locator('.res-prob-badge')).toHaveText('42%');
});

test('the "View in Network" button on a rule filters the Network tab to its pattern', async () => {
  await window.click('#consoleTabResilience');
  await window.locator('.res-rule-row').first().locator('.res-network-btn').click();

  await expect(window.locator('#consoleTabNetwork')).toHaveClass(/active/);
  await expect(window.locator('#networkFilterText')).toHaveValue('/api/resilience-target');
});
