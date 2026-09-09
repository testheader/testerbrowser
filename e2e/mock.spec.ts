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

test('the "⇒ Mock" button on a request\'s detail panel prefills method, URL, status, headers and body (#180)', async () => {
  const urlPath = '/network/status-codes.html';

  // Clear first: by this point in the file the timeline already holds every
  // event from earlier tests (initial load, api.html, the mocked fetch...).
  // Every poll tick re-renders the *entire* visible list from scratch, and
  // on a loaded CI runner that redraw can still be in flight right as
  // Playwright clicks a row — clearing keeps the list to just this one
  // request, so there's nothing expensive to race against.
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, urlPath)).waitForLoadState('load');
  await window.waitForTimeout(1_500); // pollTimeline runs every 1s

  const requestRow = window.locator('.evt.network-request', { hasText: urlPath });
  await expect(requestRow.first()).toBeVisible({ timeout: 10_000 });

  // Click the timestamp specifically — it's always at the very start of the
  // row and never a button (the per-row Replay button that used to require
  // this workaround is gone; Replay now lives in the detail panel, see #178).
  //
  // renderTimeline() also fully clears and rebuilds every row on each 1s poll
  // tick (see the comment above), so retry the click itself, not just the
  // wait, in case one is lost to a redraw detaching the row mid-click.
  const detailMockBtn = window.locator('#detailMockBtn');
  await expect(async () => {
    await requestRow.first().locator('.evt-ts').click({ timeout: 2_000 });
    await expect(detailMockBtn).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await detailMockBtn.click();

  await expect(window.locator('#mockPanel')).toBeVisible();
  await expect(window.locator('#mockUrl')).toHaveValue(fixtures.url(urlPath));
  await expect(window.locator('#mockMethod')).toHaveValue('GET');
  await expect(window.locator('#mockStatus')).toHaveValue('200');

  // Body: status-codes.html's own page load is a real text response, so it
  // has a captured, non-binary body to prefill.
  await expect(window.locator('#mockBody')).not.toHaveValue('');
  await expect(window.locator('#mockBodyNote')).toBeHidden();

  // Request headers: read-only provenance, not an editable kv-table.
  await expect(window.locator('#mockRequestHeadersCol')).toBeVisible();
  const reqHeaderRows = window.locator('#mockRequestHeadersList .mock-request-header-row');
  await expect(reqHeaderRows.first()).toBeVisible();

  // Response headers: an editable kv-table, prefilled with at least
  // content-type (an HTML page response always sets one).
  const resHeaderRows = window.locator('#mockResponseHeadersTable .kv-row');
  await expect(resHeaderRows.first()).toBeVisible();
  const resHeaderKeys = await window.locator('#mockResponseHeadersTable .kv-key').evaluateAll(
    els => (els as HTMLInputElement[]).map(el => el.value.toLowerCase())
  );
  expect(resHeaderKeys).toContain('content-type');
});

test('a mock rule\'s response headers actually reach the page (#180)', async () => {
  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabMock');
  await window.fill('#mockUrl', '*/api/headers-check');
  await window.fill('#mockStatus', '200');
  await window.fill('#mockBody', '{}');
  await window.click('#mockAddResponseHeader');
  await window.fill('#mockResponseHeadersTable .kv-key', 'X-Mock-Header');
  await window.fill('#mockResponseHeadersTable .kv-val', 'from-mock-rule');
  await window.click('.mock-add-btn');
  await expect(window.locator('.mock-rule-row').last()).toBeVisible();

  const headerValue = await tab.evaluate(async () => {
    const res = await fetch('/api/headers-check');
    return res.headers.get('x-mock-header');
  });
  expect(headerValue).toBe('from-mock-rule');
});

test('a network request\'s detail panel offers Replay, Mock and Resilience, in that order (#179)', async () => {
  const urlPath = '/network/status-codes.html';
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, urlPath)).waitForLoadState('load');
  await window.waitForTimeout(1_500);

  const requestRow = window.locator('.evt.network-request', { hasText: urlPath });
  await expect(async () => {
    await requestRow.first().locator('.evt-ts').click({ timeout: 2_000 });
    await expect(window.locator('#detailReplayBtn')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  const actions = window.locator('.detail-actions .detail-action-btn');
  await expect(actions).toHaveCount(3);
  await expect(actions.nth(0)).toHaveText('↺ Replay');
  await expect(actions.nth(1)).toHaveText('⇒ Mock');
  await expect(actions.nth(2)).toHaveText('⇒ Resilience');

  // Replay: opens the modal, prefilled from this exact call.
  await window.locator('#detailReplayBtn').click();
  await expect(window.locator('#replayOverlay')).toHaveClass(/open/);
  await expect(window.locator('#replayUrl')).toHaveValue(fixtures.url(urlPath));
  await window.click('#closeReplayBtn');

  // Resilience: switches panels and prefills the URL pattern with the exact
  // call URL (no method field exists on a resilience rule to also prefill).
  // Closing Replay doesn't touch the detail panel, so the same tab (and its
  // action row) is still showing.
  await window.locator('#detailResilienceBtn').click();
  await expect(window.locator('#resiliencePanel')).toBeVisible();
  await expect(window.locator('#resUrl')).toHaveValue(fixtures.url(urlPath));
  await expect(window.locator('#resUrl')).toBeFocused();
});

test('console rows show no Replay/Mock/Resilience action row', async () => {
  await window.click('#consoleTabConsole');
  const urlPath = '/console/logs.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await window.waitForTimeout(1_500);

  const consoleRow = window.locator('.evt.console, .evt.log').first();
  await expect(consoleRow).toBeVisible();
  await consoleRow.click();

  await expect(window.locator('.detail-tab.active')).toBeVisible();
  await expect(window.locator('.detail-actions')).toHaveCount(0);
});
