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

test('Mock tab button exists', async () => {
  const tab = window.locator('#consoleTabMock');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveText('Mock');
});

test('clicking Mock tab shows mockPanel', async () => {
  await window.locator('#consoleTabMock').click();
  const panel = window.locator('#mockPanel');
  await expect(panel).toBeVisible();
});

test('mock panel renders add-rule form elements', async () => {
  await window.locator('#consoleTabMock').click();
  // The panel initializes on first click
  await window.waitForSelector('#mockUrl', { timeout: 3000 });
  await expect(window.locator('#mockUrl')).toBeVisible();
  await expect(window.locator('#mockMethod')).toBeVisible();
  await expect(window.locator('#mockStatus')).toBeVisible();
});

test('a rule actually intercepts a matching fetch and its hit count increments', async () => {
  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabMock');
  await window.fill('#mockUrl', '*/api/widgets');
  await window.fill('#mockStatus', '201');
  await window.fill('#mockBody', '{"mocked":true}');
  await window.click('.mock-add-btn');
  await expect(window.locator('.mock-rule-row')).toBeVisible();

  // Default #apiPath value is /api/widgets — matches the rule above.
  await tab.click('#apiFetchBtn');
  await expect(tab.locator('#apiOut')).toContainText('"status":201', { timeout: 5_000 });
  const out = JSON.parse((await tab.locator('#apiOut').textContent()) || '{}');
  expect(out.status).toBe(201);
  expect(out.body).toContain('"mocked":true');

  await expect(window.locator('.mock-hits-badge')).toHaveText('Hits: 1', { timeout: 3_000 });
});
