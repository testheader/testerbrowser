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
