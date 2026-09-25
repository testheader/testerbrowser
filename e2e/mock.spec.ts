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

test('an existing mock rule can be edited in place (#182)', async () => {
  // Builds on the rule the previous test created (*/api/widgets → 201,
  // hitCount 1) — editing it in place must not reset that history.
  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabMock');
  const row = window.locator('.mock-rule-row').first();
  await row.locator('.mock-edit-btn').click();

  const editRow = window.locator('.mock-rule-row-editing');
  await expect(editRow).toBeVisible();
  await editRow.locator('.mock-edit-status').fill('503');
  await editRow.locator('.mock-save-btn').click();

  const savedRow = window.locator('.mock-rule-row').first();
  await expect(savedRow.locator('.mock-status-badge')).toHaveText('503');
  await expect(savedRow).not.toHaveClass(/mock-rule-row-editing/);

  await tab.click('#apiFetchBtn');
  await expect(tab.locator('#apiOut')).toContainText('"status":503', { timeout: 5_000 });
  // hitCount carried over from the pre-edit rule (was 1) rather than
  // resetting, and the id stayed the same (same row, not a duplicate).
  await expect(savedRow.locator('.mock-hits-badge')).toHaveText('Hits: 2', { timeout: 3_000 });
  await expect(window.locator('.mock-rule-row')).toHaveCount(1);
});

test('cancelling an edit leaves the rule unchanged', async () => {
  const row = window.locator('.mock-rule-row').first();
  await row.locator('.mock-edit-btn').click();

  const editRow = window.locator('.mock-rule-row-editing');
  await editRow.locator('.mock-edit-status').fill('599');
  await editRow.locator('.mock-cancel-btn').click();

  const restoredRow = window.locator('.mock-rule-row').first();
  await expect(restoredRow.locator('.mock-status-badge')).toHaveText('503');
  await expect(window.locator('.mock-rule-row-editing')).toHaveCount(0);
});

test('a disabled mock rule does not intercept, and stays visibly disabled across a panel re-render (#182)', async () => {
  const urlPath = '/network/api.html';
  const tab = await getTabPage(app, urlPath);

  const row = window.locator('.mock-rule-row').first();
  await row.locator('.mock-enable').uncheck();

  await expect(row).toHaveClass(/rule-row-disabled/);
  await expect(row.locator('.rule-inactive-badge')).toBeVisible();
  // Still editable while disabled.
  await expect(row.locator('.mock-edit-btn')).toBeEnabled();

  await tab.click('#apiFetchBtn');
  // Not the rule's 503 — the fixture server's real static-handler 404 for an
  // unrecognized path, since the (disabled) rule no longer intercepts it.
  await expect(tab.locator('#apiOut')).toContainText('"status":404', { timeout: 5_000 });

  // Survives the panel's own periodic re-render (loadRules() on an interval
  // while the Mock tab is active), not just the toggle's own immediate one.
  await window.click('#consoleTabNetwork');
  await window.click('#consoleTabMock');
  await expect(window.locator('.mock-rule-row').first()).toHaveClass(/rule-row-disabled/);
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

  // #232 added Copy as cURL / Copy as fetch to this same row.
  const actions = window.locator('.detail-actions .detail-action-btn');
  await expect(actions).toHaveCount(5);
  await expect(actions.nth(0)).toHaveText('↺ Replay');
  await expect(actions.nth(1)).toHaveText('⇒ Mock');
  await expect(actions.nth(2)).toHaveText('⇒ Resilience');
  await expect(actions.nth(3)).toHaveText('⧉ cURL');
  await expect(actions.nth(4)).toHaveText('⧉ fetch');

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

test('a mock rule on one tab is visible from, and intercepted by, a new tab in the same session (#209)', async () => {
  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab1 = await getTabPage(app, urlPath);

  await window.click('#consoleTabMock');
  await window.fill('#mockUrl', '*/api/session-scope');
  await window.fill('#mockStatus', '202');
  await window.fill('#mockBody', '{"scoped":true}');
  await window.click('.mock-add-btn');
  await expect(window.locator('.mock-rule-row', { hasText: '/api/session-scope' })).toBeVisible();

  // "New tab in this session" — the '+' at the end of the tab's same-partition
  // group (renderer/tabs.js), which calls sessions.create() with that same
  // partition. This tab's rules are a property of the partition (#209), not
  // of the TestSession object created for tab1, so they should carry over.
  await window.locator('.tab-group-add').first().click();

  // The new tab starts on the newtab page — navigate it to the same fixture
  // so it has #apiFetchBtn to exercise interception from.
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab2 = await getTabPage(app, urlPath, tab1);

  // mock.js's Mock panel refreshes every 1.5s while the tab is active
  // (loadRules() keyed off the now-current getActiveId()) — the new tab is
  // a different id but the same partition, so the same rule set shows.
  await expect(window.locator('.mock-rule-row', { hasText: '/api/session-scope' })).toBeVisible({ timeout: 3_000 });

  await tab2.fill('#apiPath', '/api/session-scope');
  await tab2.click('#apiFetchBtn');
  await expect(tab2.locator('#apiOut')).toContainText('"status":202', { timeout: 5_000 });
  const out = JSON.parse((await tab2.locator('#apiOut').textContent()) || '{}');
  expect(out.body).toContain('"scoped":true');

  // The hit just came from tab2, but the rule (and its updated hit count) is
  // the same partition-scoped one tab1's panel already showed — confirms
  // there's exactly one shared rule set, not two racing copies.
  await expect(window.locator('.mock-rule-row', { hasText: '/api/session-scope' }).locator('.mock-hits-badge'))
    .toHaveText('Hits: 1', { timeout: 3_000 });
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

test('a rule with a quote/HTML-bearing URL pattern and body renders safely, and round-trips through IPC unchanged (#218)', async () => {
  const evilPattern = '*/q?x="a"&y=<b>';
  const evilBody = '<b>bold</b>"quote"';

  await window.click('#consoleTabMock');
  await window.fill('#mockUrl', evilPattern);
  await window.fill('#mockStatus', '200');
  await window.fill('#mockBody', evilBody);
  await window.click('.mock-add-btn');

  const row = window.locator('.mock-rule-row', { hasText: '/q?x=' });
  await expect(row.locator('.mock-rule-url')).toHaveText(evilPattern);
  await expect(row.locator('.mock-rule-url')).toHaveAttribute('title', evilPattern);
  // Rendered as text, not markup — no real <b> element from the pattern/body leaking in.
  await expect(row.locator('b')).toHaveCount(0);

  await row.locator('.mock-edit-btn').click();
  const editRow = window.locator('.mock-rule-row-editing');
  await expect(editRow.locator('.mock-edit-url')).toHaveValue(evilPattern);
  await editRow.locator('.mock-save-btn').click();

  const activeId = await window.locator('.tab.active').getAttribute('data-id');
  const rules: { urlPattern: string; body: string }[] = await window.evaluate(
    (id) => (window as any).testerBrowser.mock.getRules(id), activeId);
  const savedRule = rules.find(r => r.urlPattern === evilPattern);
  expect(savedRule).toBeTruthy();
  expect(savedRule?.urlPattern).toBe(evilPattern);
  expect(savedRule?.body).toBe(evilBody);
});

test('a mock rule for a URL containing "?" actually matches and intercepts that exact URL (#219)', async () => {
  // Earlier tests in this file (#209, #218) leave multiple tabs open,
  // including more than one already on /network/api.html — reduce to a
  // single tab first so getTabPage's URL-substring match below is
  // unambiguous.
  for (let i = 0; i < 10 && (await window.locator('.tab').count()) > 1; i++) {
    await window.keyboard.press('Control+w');
  }
  await expect.poll(() => window.locator('.tab').count()).toBe(1);

  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabMock');
  await window.fill('#mockUrl', '*/api/items?page=2');
  await window.fill('#mockStatus', '200');
  await window.fill('#mockBody', '{"mocked":true}');
  await window.click('.mock-add-btn');
  await expect(window.locator('.mock-rule-row', { hasText: '/api/items' })).toBeVisible();

  await tab.fill('#apiPath', '/api/items?page=2');
  await tab.click('#apiFetchBtn');
  await expect(tab.locator('#apiOut')).toContainText('"status":200', { timeout: 5_000 });
  const out = JSON.parse((await tab.locator('#apiOut').textContent()) || '{}');
  expect(out.body).toContain('"mocked":true');
});

test('"⇒ Mock" from a gzip-encoded response leaves out encoding headers, and an edited body round-trips (#235)', async () => {
  for (let i = 0; i < 10 && (await window.locator('.tab').count()) > 1; i++) {
    await window.keyboard.press('Control+w');
  }
  await expect.poll(() => window.locator('.tab').count()).toBe(1);

  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await tab.fill('#apiPath', '/network/gzip-json');
  await tab.click('#apiFetchBtn');
  await expect(tab.locator('#apiOut')).toContainText('"status":200', { timeout: 5_000 });
  await window.waitForTimeout(1_500); // pollTimeline

  const requestRow = window.locator('.evt.network-request', { hasText: 'gzip-json' });
  await expect(requestRow.first()).toBeVisible({ timeout: 10_000 });
  const detailMockBtn = window.locator('#detailMockBtn');
  await expect(async () => {
    await requestRow.first().locator('.evt-ts').click({ timeout: 2_000 });
    await expect(detailMockBtn).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await detailMockBtn.click();

  await expect(window.locator('#mockPanel')).toBeVisible();
  const resHeaderKeys = await window.locator('#mockResponseHeadersTable .kv-key').evaluateAll(
    els => (els as HTMLInputElement[]).map(el => el.value.toLowerCase())
  );
  expect(resHeaderKeys).not.toContain('content-encoding');
  expect(resHeaderKeys).not.toContain('content-length');

  // Edit the prefilled body to something longer than the original gzipped
  // payload decodes to — the old bug truncated/corrupted this via a stale
  // content-length carried into the fulfilled response.
  const longerBody = JSON.stringify({ from: 'server', edited: true, padding: 'x'.repeat(200) });
  await window.fill('#mockUrl', fixtures.url('/network/gzip-json'));
  await window.fill('#mockBody', longerBody);
  await window.click('.mock-add-btn');
  await expect(window.locator('.mock-rule-row', { hasText: 'gzip-json' })).toBeVisible();

  const fetched = await tab.evaluate(async (url) => {
    const r = await fetch(url);
    return { body: await r.text(), contentType: r.headers.get('content-type') };
  }, fixtures.url('/network/gzip-json'));
  expect(JSON.parse(fetched.body)).toEqual(JSON.parse(longerBody));
  expect(fetched.contentType).toContain('application/json');
});

test('a mock rule row keeps the tab it was rendered for, even after switching tabs (#235)', async () => {
  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await getTabPage(app, urlPath);
  const tabAId = await window.locator('.tab.active').getAttribute('data-id');

  await window.click('#consoleTabMock');
  await window.fill('#mockUrl', '*/api/owning-tab');
  await window.fill('#mockStatus', '200');
  await window.fill('#mockBody', '{"v":1}');
  await window.click('.mock-add-btn');
  const row = window.locator('.mock-rule-row', { hasText: 'owning-tab' });
  await expect(row).toBeVisible();

  await row.locator('.mock-edit-btn').click();
  const editRow = window.locator('.mock-rule-row-editing');
  await editRow.locator('.mock-edit-status').fill('202');

  // Switch to a different tab and back before saving — the edit must still
  // apply to the tab (and partition) it was actually opened for, not
  // whichever tab happens to be active at save time. Note: re-clicking the
  // Mock console tab (rather than just switching browser tabs) would itself
  // re-run initMock()'s loadRules() and blow away the open edit row, so this
  // deliberately never touches #consoleTabMock again once the row is open.
  const tabCountBefore = await window.locator('.tab').count();
  await window.click('#newSessionBtn');
  await expect.poll(() => window.locator('.tab').count()).toBe(tabCountBefore + 1);
  await window.keyboard.press('Control+Tab');
  await expect.poll(() => window.locator('.tab.active').getAttribute('data-id')).toBe(tabAId);

  await window.locator('.mock-rule-row-editing .mock-save-btn').click();
  await expect(window.locator('.mock-rule-row', { hasText: 'owning-tab' }).locator('.mock-status-badge')).toHaveText('202');

  // Now edit again, but this time close the owning tab before saving. The
  // active tab right now is still the owning tab (tabA) — the Ctrl+Tab
  // above went *to* it from the new tab, so this row's edit captures its id.
  await window.locator('.mock-rule-row', { hasText: 'owning-tab' }).locator('.mock-edit-btn').click();
  const editRow2 = window.locator('.mock-rule-row-editing');
  await editRow2.locator('.mock-edit-status').fill('204');

  await window.keyboard.press('Control+w'); // closes the owning tab (still active); auto-switches to the other tab
  await expect.poll(() => window.locator('.tab.active').getAttribute('data-id')).not.toBe(tabAId);
  await window.locator('.mock-rule-row-editing .mock-save-btn').click();

  await expect(window.locator('.mock-row-error')).toHaveText('That tab was closed — rule not saved');
});
