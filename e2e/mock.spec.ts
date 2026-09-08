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

test('the "⇒ Mock" button on a request\'s detail panel prefills method, URL, status and body', async () => {
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

  // Click the timestamp, not the summary as a whole: a network-request row's
  // summary also contains the "↺ Replay" button, which stops propagation and
  // opens the Replay modal instead of the detail tab. Playwright clicks the
  // centre of the element it is given, and how far along the row that centre
  // falls depends on the window width — on the Windows CI runner it landed on
  // that button, so the detail tab never opened. The timestamp is always at
  // the very start of the row and never a button.
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
});
