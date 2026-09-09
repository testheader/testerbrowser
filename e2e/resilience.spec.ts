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

test('sending a captured POST request to Resilience scopes the rule to that method (#181)', async () => {
  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  const targetUrl = fixtures.url('/api/resilience-method-check');

  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  // A previous test ("View in Network") left the free-text filter set to its
  // own pattern — clear it so this test's own request isn't hidden by it.
  await window.fill('#networkFilterText', '');
  await tab.evaluate((url) => fetch(url, { method: 'POST', body: '{"x":1}' }).catch(() => {}), targetUrl);
  await window.waitForTimeout(1_500);

  const requestRow = window.locator('.evt.network-request', { hasText: '/api/resilience-method-check' });
  await expect(async () => {
    await requestRow.first().locator('.evt-ts').click({ timeout: 2_000 });
    await expect(window.locator('#detailResilienceBtn')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await window.locator('#detailResilienceBtn').click();
  await expect(window.locator('#resiliencePanel')).toBeVisible();
  await expect(window.locator('#resUrl')).toHaveValue(targetUrl);
  // Defaults for a one-click reproduction: 500 error, 100%.
  await expect(window.locator('#resType')).toHaveValue('error500');
  await expect(window.locator('#resProb')).toHaveValue('100');

  await window.click('.res-add-btn');
  const newRow = window.locator('.res-rule-row', { hasText: '/api/resilience-method-check' });
  await expect(newRow).toBeVisible();
  // The rule row shows the method it's scoped to (only when it isn't '*').
  await expect(newRow.locator('.res-method-badge')).toHaveText('POST');

  // Method scoping in effect: the same POST is degraded...
  const postStatus = await tab.evaluate(
    (url) => fetch(url, { method: 'POST', body: '{"x":1}' }).then(r => r.status),
    targetUrl
  );
  expect(postStatus).toBe(500);

  // ...but a GET to the exact same URL reaches the real fixture server
  // instead (a 404 from its static handler, per api.html's own fixture note
  // — not artificially failed by the rule).
  const getStatus = await tab.evaluate((url) => fetch(url).then(r => r.status), targetUrl);
  expect(getStatus).toBe(404);

  // Provenance: the request headers/body this rule was created from are
  // shown read-only in its edit view, not sent anywhere or matched against.
  await newRow.locator('.res-edit-btn').click();
  const editRow = window.locator('.res-rule-row-editing');
  await expect(editRow.locator('.res-provenance')).toBeVisible();
  await expect(editRow.locator('.res-provenance-body')).toHaveText('{"x":1}');
  await editRow.locator('.res-cancel-btn').click();
});
