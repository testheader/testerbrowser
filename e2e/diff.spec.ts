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

// #253: each free-text filter test below calls this itself rather than
// relying on whichever test happened to run before it leaving the right
// comparison behind — every session this creates is a fresh one (tracked via
// idsBefore, the same pattern used elsewhere in this suite for order
// independence), so each test passes identically alone (`-g`) or as part of
// the full file, in any order.
async function setupDiffFreeTextComparison(): Promise<{ sessionAId: string; sessionBId: string }> {
  const sharedPath = '/network/status-codes.html';
  const onlyAPath = '/downloads/sample.txt';

  const idsBefore = new Set(
    (await window.evaluate(() => (window as any).testerBrowser.sessions.list())).map((s: { id: string }) => s.id)
  );

  await window.click('#newSessionBtn');
  let sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const sessionAId = sessions.map((s: { id: string }) => s.id).find((id: string) => !idsBefore.has(id));
  idsBefore.add(sessionAId);

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), sessionAId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(sharedPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, sharedPath)).waitForLoadState('load');
  // Editing the urlbar again immediately after the previous Enter-triggered
  // navigation races the urlbar's own async post-navigation update (see
  // followalong.spec.ts's identical wait for the same reason) — under load
  // (more tabs open, as later calls to this helper see), the second fill can
  // land before that settles and get silently dropped/overwritten, causing
  // this session to load sharedPath twice and never reach onlyAPath at all.
  await expect(window.locator('#urlbar')).toHaveValue(fixtures.url(sharedPath), { timeout: 5_000 });

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(onlyAPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, onlyAPath)).waitForLoadState('load');

  await window.click('#newSessionBtn');
  sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const sessionBId = sessions.map((s: { id: string }) => s.id).find((id: string) => !idsBefore.has(id));

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), sessionBId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(sharedPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, sharedPath)).waitForLoadState('load');

  await window.click('#consoleTabDiff');
  await window.selectOption('#diffPickA', sessionAId);
  await window.selectOption('#diffPickB', sessionBId);
  await window.click('#diffRunBtn');
  // #diffRunBtn's click resolving only means the click event was dispatched,
  // not that its (async) diff computation has rendered every row yet — a
  // download's request can land in the recording via a slightly different/
  // slower CDP path than a plain page navigation, making the "only in A"
  // row for onlyAPath the last one to appear. Wait for it specifically
  // (Playwright's own retry) instead of assuming the click alone means the
  // table is fully settled — every caller of this helper depends on that row
  // existing.
  await expect(window.locator('.diff-row', { hasText: onlyAPath })).toBeVisible({ timeout: 10_000 });

  return { sessionAId, sessionBId };
}

test('a positive free-text term narrows the table to matching URLs, and clearing restores every row', async () => {
  await setupDiffFreeTextComparison();

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

test('a negative -term hides matching URLs', async () => {
  // Just the wiring proof (#diffFilterText -> matching -> DOM) — combined
  // positive+negative terms and the lone-"-" literal case are pure
  // matchesFreeText logic, already covered by
  // src/__tests__/matches-free-text.test.ts (#251).
  await setupDiffFreeTextComparison();

  await window.fill('#diffFilterText', '-sample');
  await expect(window.locator('.diff-row', { hasText: '/downloads/sample.txt' })).toHaveCount(0);
  await expect(window.locator('.diff-row', { hasText: '/network/status-codes.html' }).first()).toBeVisible();
  await window.fill('#diffFilterText', '');
});

test('Reset also clears the free-text filter input', async () => {
  await setupDiffFreeTextComparison();

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
  // Kept open for the whole test (never navigates away from sharedPath), so
  // it's passed as `exclude` below — otherwise getTabPage's URL-substring
  // match is ambiguous between this tab and session B's, and could resolve
  // to this already-loaded tab instead of waiting on session B's own
  // navigation to actually finish.
  const tabA = await getTabPage(app, sharedPath);
  await tabA.waitForLoadState('load');

  await window.click('#newSessionBtn');
  await expect.poll(() => window.locator('.tab').count()).toBe(2);
  const sessionBId = await activeTabId();
  expect(sessionBId).not.toBe(sessionAId);

  await window.click('#urlbar');
  // Same path, a different host — localhost and 127.0.0.1 are distinct
  // origins even though they resolve to the same server here.
  await window.fill('#urlbar', `http://localhost:${fixtures.port}${sharedPath}`);
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, sharedPath, tabA)).waitForLoadState('load');

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
  await (await getTabPage(app, '/network/header?v=1')).waitForLoadState('load');

  await window.click('#newSessionBtn');
  await expect.poll(() => window.locator('.tab').count()).toBe(2);
  const sessionBId = await activeTabId();
  expect(sessionBId).not.toBe(sessionAId);

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/network/header?v=2'));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, '/network/header?v=2')).waitForLoadState('load');

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
