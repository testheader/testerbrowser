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
});
