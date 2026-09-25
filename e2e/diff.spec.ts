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

test('Diff tab button is present', async () => {
  await expect(window.locator('#consoleTabDiff')).toBeVisible();
});

test('clicking Diff tab shows diffPanel', async () => {
  await window.locator('#consoleTabDiff').click();
  await expect(window.locator('#diffPanel')).toBeVisible();
});

test('diffPanel contains session pickers A and B', async () => {
  await window.locator('#consoleTabDiff').click();
  // initDiff populates pickers on first click; wait briefly
  await window.waitForTimeout(200);
  await expect(window.locator('#diffPickA')).toBeAttached();
  await expect(window.locator('#diffPickB')).toBeAttached();
});

test('diffPanel contains a Run diff button', async () => {
  await window.locator('#consoleTabDiff').click();
  await window.waitForTimeout(200);
  await expect(window.locator('#diffRunBtn')).toBeAttached();
});

test('diffPanel contains a HAR export button', async () => {
  await window.locator('#consoleTabDiff').click();
  await window.waitForTimeout(200);
  await expect(window.locator('#diffHarBtn')).toBeAttached();
});

test('comparing two sessions categorizes matching and unique requests correctly', async () => {
  // Deliberately navigation-only (no post-load button clicks): a fetch
  // triggered by clicking a button on a second, non-default session has
  // proven unreliable to drive from here, in a way a plain page load isn't —
  // the page load itself already produces a real, recordable network event.
  const sharedPath = '/network/status-codes.html';
  const onlyAPath = '/downloads/sample.txt';

  const sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const sessionAId = sessions[0].id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), sessionAId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(sharedPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, sharedPath)).waitForLoadState('load');

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(onlyAPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, onlyAPath)).waitForLoadState('load');

  await window.click('#newSessionBtn');
  const allSessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const sessionBId = allSessions.find((s: { id: string }) => s.id !== sessionAId).id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), sessionBId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(sharedPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, sharedPath)).waitForLoadState('load');

  await window.click('#consoleTabDiff');
  await window.selectOption('#diffPickA', sessionAId);
  await window.selectOption('#diffPickB', sessionBId);
  await window.click('#diffRunBtn');

  // Both sessions loaded status-codes.html → same. Only session A loaded sample.txt.
  await expect(window.locator('.diff-row.same', { hasText: '/network/status-codes.html' })).toBeVisible();
  await expect(window.locator('.diff-row.only-a', { hasText: '/downloads/sample.txt' })).toBeVisible();
});

test('diff shows which sessions (by name) were compared and when', async () => {
  const sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  await window.selectOption('#diffPickA', sessions[0].id);
  await window.selectOption('#diffPickB', sessions[1].id);
  await window.click('#diffRunBtn');

  const meta = window.locator('.diff-meta');
  await expect(meta).toBeVisible();
  await expect(meta).toContainText(sessions[0].name);
  await expect(meta).toContainText(sessions[1].name);
});

test('category pills filter the table while the legend keeps showing totals', async () => {
  await expect(window.locator('.diff-row')).not.toHaveCount(0);
  const sameCountBefore = await window.locator('.diff-row.same').count();
  expect(sameCountBefore).toBeGreaterThan(0);

  await window.locator('#diffCatPills .filter-pill[data-cat="same"]').click();
  await expect(window.locator('.diff-row.same')).toHaveCount(0);
  // Legend badge count is unaffected by the pill filter.
  await expect(window.locator('.diff-badge.same')).toContainText(String(sameCountBefore));

  await window.locator('#diffCatPills .filter-pill[data-cat="same"]').click();
  await expect(window.locator('.diff-row.same')).toHaveCount(sameCountBefore);
});

test('Reset clears the comparison back to its initial state and disables HAR export', async () => {
  await expect(window.locator('.diff-row')).not.toHaveCount(0);
  await expect(window.locator('#diffHarBtn')).not.toBeDisabled();

  await window.click('#diffResetBtn');

  await expect(window.locator('.diff-hint')).toHaveText('Select two sessions above and click Compare.');
  await expect(window.locator('.diff-row')).toHaveCount(0);
  await expect(window.locator('.diff-meta')).toHaveCount(0);
  await expect(window.locator('#diffHarBtn')).toBeDisabled();
});

// ── Free-text filtering of the diff table (#164) ─────────────────────────────

test('a positive free-text term narrows the table to matching URLs, and clearing restores every row', async () => {
  const sharedPath = '/network/status-codes.html';
  const onlyAPath = '/downloads/sample.txt';

  const sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const sessionAId = sessions[0].id;
  const sessionBId = sessions[1].id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), sessionAId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(sharedPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, sharedPath)).waitForLoadState('load');

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(onlyAPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, onlyAPath)).waitForLoadState('load');

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), sessionBId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(sharedPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, sharedPath)).waitForLoadState('load');

  await window.click('#consoleTabDiff');
  await window.selectOption('#diffPickA', sessionAId);
  await window.selectOption('#diffPickB', sessionBId);
  await window.click('#diffRunBtn');

  const totalRows = await window.locator('.diff-row').count();
  expect(totalRows).toBeGreaterThan(1);
  const sameCount = await window.locator('.diff-badge.same').textContent();

  await window.fill('#diffFilterText', 'sample.txt');
  await expect(window.locator('.diff-row')).toHaveCount(1);
  await expect(window.locator('.diff-row', { hasText: '/downloads/sample.txt' })).toBeVisible();
  // Legend is unaffected by the text filter, same as the category pills.
  await expect(window.locator('.diff-badge.same')).toHaveText(sameCount!);

  await window.fill('#diffFilterText', '');
  await expect(window.locator('.diff-row')).toHaveCount(totalRows);
});

test('a negative -term hides matching URLs, and combined terms apply both rules together', async () => {
  await window.fill('#diffFilterText', '-sample');
  await expect(window.locator('.diff-row', { hasText: '/downloads/sample.txt' })).toHaveCount(0);
  await expect(window.locator('.diff-row', { hasText: '/network/status-codes.html' }).first()).toBeVisible();

  await window.fill('#diffFilterText', 'downloads -sample');
  await expect(window.locator('.diff-row')).toHaveCount(0);

  await window.fill('#diffFilterText', '');
});

test('a lone "-" is treated as a literal character rather than a negation', async () => {
  // "-" as a bare term is a positive literal match, not a negation: it keeps
  // only URLs that actually contain a hyphen (status-codes.html) and hides
  // the ones that don't (sample.txt) — the opposite of what negation would do.
  await window.fill('#diffFilterText', '-');
  await expect(window.locator('.diff-row', { hasText: '/downloads/sample.txt' })).toHaveCount(0);
  await expect(window.locator('.diff-row', { hasText: '/network/status-codes.html' }).first()).toBeVisible();
  await window.fill('#diffFilterText', '');
});

test('Reset also clears the free-text filter input', async () => {
  await window.fill('#diffFilterText', 'sample');
  await expect(window.locator('#diffFilterText')).toHaveValue('sample');

  await window.click('#diffResetBtn');

  await expect(window.locator('#diffFilterText')).toHaveValue('');
});

// ── Host-agnostic matching (#237) ────────────────────────────────────────

// Local to this file (shortcuts.spec.ts has its own copy) — earlier tests
// in this file can leave an arbitrary number of tabs open, and the tests
// below need to know exactly which two sessions they're comparing rather
// than guessing from sessions.list() order.
async function resetToSingleTab() {
  for (let i = 0; i < 20 && (await window.locator('.tab').count()) > 1; i++) {
    await window.keyboard.press('Control+w');
  }
  await expect.poll(() => window.locator('.tab').count()).toBe(1);
}

async function activeTabId(): Promise<string> {
  const id = await window.evaluate(() => document.querySelector('.tab.active')?.getAttribute('data-id'));
  if (!id) throw new Error('No active tab found');
  return id;
}

test('"Path only" matching treats the same path on two different hosts as the same request', async () => {
  await resetToSingleTab();
  const sharedPath = '/network/status-codes.html';

  const sessionAId = await activeTabId();
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(sharedPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, sharedPath)).waitForLoadState('load');

  await window.click('#newSessionBtn');
  await expect.poll(() => window.locator('.tab').count()).toBe(2);
  const sessionBId = await activeTabId();
  expect(sessionBId).not.toBe(sessionAId);

  await window.click('#urlbar');
  // Same path, a different host — localhost and 127.0.0.1 are distinct
  // origins even though they resolve to the same server here.
  await window.fill('#urlbar', `http://localhost:${fixtures.port}${sharedPath}`);
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, sharedPath)).waitForLoadState('load');

  await window.click('#consoleTabDiff');
  await window.selectOption('#diffPickA', sessionAId);
  await window.selectOption('#diffPickB', sessionBId);
  await expect(window.locator('#diffMatchMode')).toHaveValue('full');
  await window.click('#diffRunBtn');

  // Full URL mode: different hosts, so this pair never lands as "same".
  await expect(window.locator('.diff-row.same', { hasText: sharedPath })).toHaveCount(0);

  await window.selectOption('#diffMatchMode', 'path');
  await expect(window.locator('.diff-row.same', { hasText: sharedPath })).toBeVisible();

  await window.selectOption('#diffMatchMode', 'full'); // leave state clean for later tests
  await window.click('#diffResetBtn');
});

test('expanding a matched row shows a changed response header, once its query param is ignored (#237)', async () => {
  await resetToSingleTab();
  const sessionAId = await activeTabId();
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/network/header?v=1'));
  await window.press('#urlbar', 'Enter');
  await window.waitForTimeout(500);

  await window.click('#newSessionBtn');
  await expect.poll(() => window.locator('.tab').count()).toBe(2);
  const sessionBId = await activeTabId();
  expect(sessionBId).not.toBe(sessionAId);

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/network/header?v=2'));
  await window.press('#urlbar', 'Enter');
  await window.waitForTimeout(500);

  await window.click('#consoleTabDiff');
  await window.selectOption('#diffPickA', sessionAId);
  await window.selectOption('#diffPickB', sessionBId);
  await window.fill('#diffIgnoreParams', 'v, _, cb, ts, t, timestamp, nocache, utm_*, gclid, fbclid');
  await window.locator('#diffIgnoreParams').blur();
  await window.click('#diffRunBtn');

  const row = window.locator('.diff-row', { hasText: '/network/header' });
  await expect(row).toBeVisible();
  // Status matches on both sides (200) — category stays "same", with the
  // secondary marker for the header difference the ignore list doesn't hide.
  await expect(row).toHaveClass(/same/);
  await expect(row.locator('.diff-badge.hb-diff')).toBeVisible();

  await row.click();
  const detail = window.locator('.diff-detail-row');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('x-variant');
  await expect(detail).toContainText('1');
  await expect(detail).toContainText('2');

  await window.click('#diffResetBtn');
});
