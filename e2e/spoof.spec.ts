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

test('Spoof tab button is present', async () => {
  await expect(window.locator('#consoleTabSpoof')).toBeVisible();
});

test('Tokyo preset fills the form and Apply issues the CDP overrides without error', async () => {
  // NOTE: this can't assert the resulting Intl.DateTimeFormat()/navigator.language
  // values the way the other panels' tests assert real effects. Confirmed via direct
  // CDP probing: Emulation.setTimezoneOverride/setLocaleOverride resolve successfully
  // and DO take effect for JS evaluated through the same CDP session that set them,
  // but Playwright drives this app through its own, separate CDP session on the same
  // target — and Chromium scopes these overrides per session, so Playwright's own
  // page.evaluate() never observes them regardless of whether the app's plumbing is
  // correct. That's a real Chromium/CDP behavior, not a bug in this app, but it means
  // an e2e assertion on the resulting Intl value would be testing the test harness's
  // CDP session, not the feature. What *is* real app behavior, and what this checks:
  // the preset fills the form correctly, and Apply resolves without throwing.
  const urlPath = '/index.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await getTabPage(app, urlPath);

  await window.click('#consoleTabSpoof');
  await window.click('button.spoof-preset-btn:text("Tokyo")');
  await expect(window.locator('#spoofTimezone')).toHaveValue('Asia/Tokyo');
  await expect(window.locator('#spoofLocale')).toHaveValue('ja-JP');

  await window.click('#spoofApply');
  await expect(window.locator('#spoofStatus')).toContainText('Overrides applied', { timeout: 5_000 });

  await window.click('#spoofReset');
  await expect(window.locator('#spoofStatus')).toContainText('Overrides cleared', { timeout: 5_000 });
});

test('the "currently applied" indicator reflects apply/reset, and unapplied edits are flagged', async () => {
  await window.click('#consoleTabSpoof');
  await expect(window.locator('#spoofCurrent')).toContainText('No overrides applied', { timeout: 5_000 });
  // The previous test left stale, unapplied values in the fields (backend was
  // reset, but the inputs were never cleared) — reset the fields to match the
  // "nothing applied" backend state before asserting a clean, non-dirty panel.
  for (const id of ['#spoofTimezone', '#spoofLocale', '#spoofLat', '#spoofLon']) {
    await window.fill(id, '');
  }
  await expect(window.locator('#spoofDirty')).toBeHidden();

  await window.click('button.spoof-preset-btn:text("Berlin")');
  await expect(window.locator('#spoofDirty')).toBeVisible();

  await window.click('#spoofApply');
  await expect(window.locator('#spoofCurrent')).toContainText('Europe/Berlin', { timeout: 5_000 });
  await expect(window.locator('#spoofDirty')).toBeHidden();

  await window.fill('#spoofTimezone', 'Asia/Tokyo');
  await expect(window.locator('#spoofDirty')).toBeVisible();
  await expect(window.locator('#spoofCurrent')).toContainText('Europe/Berlin');

  await window.click('#spoofReset');
  await expect(window.locator('#spoofCurrent')).toContainText('No overrides applied', { timeout: 5_000 });
});

test('"Use current values" fills timezone and locale from this machine, and reports the geolocation outcome', async () => {
  await window.click('#consoleTabSpoof');
  for (const id of ['#spoofTimezone', '#spoofLocale', '#spoofLat', '#spoofLon']) {
    await window.fill(id, '');
  }

  const expected = await window.evaluate(() => ({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language,
  }));

  await window.click('#spoofUseCurrent');
  await expect(window.locator('#spoofTimezone')).toHaveValue(expected.timezone);
  await expect(window.locator('#spoofLocale')).toHaveValue(expected.locale);

  // This chrome window's session has no permission handler attached, so
  // geolocation may succeed or fail depending on the OS/CI environment —
  // either is fine, but the action must always report an outcome, and never
  // block the timezone/locale fill above on it.
  await expect(window.locator('#spoofStatus')).toContainText(/location/i, { timeout: 9_000 });
});

test('a signed clock offset advances or rewinds Date.now() in the page, and Reset restores real time', async () => {
  // The Date shim is injected via Page.addScriptToEvaluateOnNewDocument, so
  // it only takes effect on the tab's *next* navigation — unlike the
  // Emulation-domain overrides above, it is not scoped to a separate CDP
  // session, so it genuinely is observable through Playwright's own
  // page.evaluate() once the tab reloads.
  // Not '/index.html': the chrome shell's own file:// URL also ends in
  // "/index.html", so getTabPage(app, '/index.html') would resolve to the
  // app's own window instead of the fixture tab (see shortcuts.spec.ts).
  const urlPath = '/network/status-codes.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabSpoof');
  await window.fill('#spoofOffsetValue', '1'); // unit defaults to days
  await window.click('#spoofApply');
  await expect(window.locator('#spoofStatus')).toContainText('Overrides applied', { timeout: 5_000 });
  await expect(window.locator('#spoofCurrent')).toContainText('clock +1d', { timeout: 5_000 });

  // The shim is registered via Page.addScriptToEvaluateOnNewDocument on a
  // debugger session separate from the one Playwright uses to drive
  // tab.reload(), so its execution on the freshly-created document isn't
  // ordered against reload()'s own resolution — poll for the marker instead
  // of asserting immediately, to avoid a race with script injection timing.
  await tab.reload();
  await expect.poll(
    () => tab.evaluate(() => (window as unknown as { __tbDateOverridden?: boolean }).__tbDateOverridden),
    { timeout: 10_000 }
  ).toBe(true);
  const forwardNow = await tab.evaluate(() => Date.now());
  expect(Math.abs(forwardNow - (Date.now() + 86_400_000))).toBeLessThan(10_000);

  await window.fill('#spoofOffsetValue', '-2');
  await window.selectOption('#spoofOffsetUnit', '3600000'); // hours
  await window.click('#spoofApply');
  await expect(window.locator('#spoofStatus')).toContainText('Overrides applied', { timeout: 5_000 });
  await expect(window.locator('#spoofCurrent')).toContainText('clock -2h', { timeout: 5_000 });

  await tab.reload();
  await expect.poll(
    () => tab.evaluate(() => (window as unknown as { __tbDateOverridden?: boolean }).__tbDateOverridden),
    { timeout: 10_000 }
  ).toBe(true);
  const backwardNow = await tab.evaluate(() => Date.now());
  expect(Math.abs(backwardNow - (Date.now() - 2 * 3_600_000))).toBeLessThan(10_000);

  await window.click('#spoofReset');
  await expect(window.locator('#spoofStatus')).toContainText('Overrides cleared', { timeout: 5_000 });
  await tab.reload();
  await expect.poll(
    () => tab.evaluate(() => (window as unknown as { __tbDateOverridden?: boolean }).__tbDateOverridden),
    { timeout: 10_000 }
  ).toBeFalsy();
  const realNow = await tab.evaluate(() => Date.now());
  expect(Math.abs(realNow - Date.now())).toBeLessThan(10_000);
});
