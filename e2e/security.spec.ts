import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

let app: Awaited<ReturnType<typeof electron.launch>>;
let page: Awaited<ReturnType<typeof app.firstWindow>>;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await launchApp(MAIN_PATH);
  page = await getMainWindow(app);
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

test('Security tab button exists', async () => {
  const tab = page.locator('#consoleTabSecurity');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveText('Security');
});

test('clicking Security tab shows securityPanel', async () => {
  await page.locator('#consoleTabSecurity').click();
  await expect(page.locator('#securityPanel')).toBeVisible();
});

test('Security tab is marked active after click', async () => {
  await page.locator('#consoleTabSecurity').click();
  await expect(page.locator('#consoleTabSecurity')).toHaveClass(/active/);
});

test('Scan session button exists in panel', async () => {
  await page.locator('#consoleTabSecurity').click();
  await expect(page.locator('#secScanBtn')).toBeVisible();
});

test('securityPanel shows hint text initially', async () => {
  await page.locator('#consoleTabSecurity').click();
  await expect(page.locator('#secResults .sec-hint')).toBeVisible();
});

test('scan reports a real HTTP finding, and a row opens the detail panel', async () => {
  // Not testing the cookie findings here: Chromium's Network domain never
  // exposes Set-Cookie in Network.responseReceived's headers (it's only on
  // the separate Network.responseReceivedExtraInfo event, which the recorder
  // doesn't currently listen to) — so analyze()'s cookie checks are
  // unreachable via normal page loads regardless of what the response sends.
  const urlPath = '/storage/set-cookie?name=sec_test&value=1';
  await page.click('#urlbar');
  await page.fill('#urlbar', fixtures.url(urlPath));
  await page.press('#urlbar', 'Enter');
  await page.waitForTimeout(1_000);

  await page.click('#consoleTabSecurity');
  await page.click('#secScanBtn');
  await expect(page.locator('#secStatus')).not.toHaveText('Scanning…', { timeout: 5_000 });

  // Fixture server is plain HTTP — this finding always fires for any page load.
  await expect(page.locator('.sec-row', { hasText: 'HTTP (unencrypted)' }).first()).toBeVisible();

  await page.locator('.sec-row', { hasText: 'HTTP (unencrypted)' }).first().click();
  await expect(page.locator('#detailPanelTabBar .detail-tab')).toHaveCount(1);
});

test('"Configure checks" lets a rule be disabled, and the override persists across settings reads', async () => {
  const urlPath = '/network/status-codes.html';
  await page.click('#urlbar');
  await page.fill('#urlbar', fixtures.url(urlPath));
  await page.press('#urlbar', 'Enter');
  await page.waitForTimeout(1_000);

  await page.click('#consoleTabSecurity');
  await page.click('#secScanBtn');
  await expect(page.locator('#secStatus')).not.toHaveText('Scanning…', { timeout: 5_000 });
  await expect(page.locator('.sec-row', { hasText: 'HTTP (unencrypted)' }).first()).toBeVisible();

  await page.click('#secConfigBtn');
  const httpRuleCheckbox = page.locator('.sec-config-row', { hasText: 'HTTP (unencrypted)' }).locator('input');
  await expect(httpRuleCheckbox).toBeChecked();
  await httpRuleCheckbox.uncheck();

  // Persisted immediately via settings:set — a fresh read sees the override
  // without needing the panel to still be open.
  const overrides = await page.evaluate(() => (window as any).testerBrowser.settings.get());
  expect(overrides.securityRuleOverrides['http-unencrypted']).toBe(false);

  await page.click('#secConfigBtn'); // close the config panel
  await page.click('#secScanBtn');
  await expect(page.locator('#secStatus')).not.toHaveText('Scanning…', { timeout: 5_000 });
  await expect(page.locator('.sec-row', { hasText: 'HTTP (unencrypted)' })).toHaveCount(0);

  // Re-enable it so later tests in this file aren't affected by this one.
  await page.click('#secConfigBtn');
  await page.locator('.sec-config-row', { hasText: 'HTTP (unencrypted)' }).locator('input').check();
  await page.click('#secConfigBtn');
  await page.click('#secScanBtn');
  await expect(page.locator('#secStatus')).not.toHaveText('Scanning…', { timeout: 5_000 });
  await expect(page.locator('.sec-row', { hasText: 'HTTP (unencrypted)' }).first()).toBeVisible();
});

test('a severity master checkbox toggles the whole group, and goes indeterminate on a mixed selection (#187)', async () => {
  const urlPath = '/network/status-codes.html';
  await page.click('#urlbar');
  await page.fill('#urlbar', fixtures.url(urlPath));
  await page.press('#urlbar', 'Enter');
  await page.waitForTimeout(1_000);

  await page.click('#consoleTabSecurity');
  await page.click('#secConfigBtn');

  const mediumGroup   = page.locator('.sec-config-group', { has: page.locator('.sec-config-group-label.sec-medium') });
  const mediumMaster  = mediumGroup.locator('.sec-config-group-label input');
  const mediumRows    = mediumGroup.locator('.sec-config-row input');
  const highGroup     = page.locator('.sec-config-group', { has: page.locator('.sec-config-group-label.sec-high') });
  const highMaster    = highGroup.locator('.sec-config-group-label input');
  const highRows      = highGroup.locator('.sec-config-row input');

  const mediumCount = await mediumRows.count();
  const highChecked = await Promise.all((await highRows.all()).map(cb => cb.isChecked()));

  await expect(mediumMaster).toBeChecked();

  // Unticking the master disables every rule in the group in one write, and
  // leaves the other groups untouched.
  await mediumMaster.uncheck();
  for (const cb of await mediumRows.all()) await expect(cb).not.toBeChecked();
  await expect(highMaster).toBeChecked();
  expect(await Promise.all((await highRows.all()).map(cb => cb.isChecked()))).toEqual(highChecked);

  const overridesAfterUncheck = await page.evaluate(() => (window as any).testerBrowser.settings.get());
  const mediumRuleIds = ['csp-wildcard-source']; // spot check one; full disable verified via checkbox state above
  for (const id of mediumRuleIds) expect(overridesAfterUncheck.securityRuleOverrides[id]).toBe(false);

  // Re-checking one individual rule makes the master indeterminate, not checked.
  await mediumRows.first().check();
  await expect(mediumMaster).not.toBeChecked();
  const masterIsIndeterminate = () => mediumMaster.evaluate((el: HTMLInputElement) => el.indeterminate);
  expect(await masterIsIndeterminate()).toBe(true);

  // Ticking the master re-enables the whole group in one write.
  await mediumMaster.check();
  expect(await masterIsIndeterminate()).toBe(false);
  for (const cb of await mediumRows.all()) await expect(cb).toBeChecked();

  // State survives closing and reopening the panel.
  await page.click('#secConfigBtn');
  await page.click('#secConfigBtn');
  const mediumMasterReopened = page.locator('.sec-config-group', { has: page.locator('.sec-config-group-label.sec-medium') })
    .locator('.sec-config-group-label input');
  await expect(mediumMasterReopened).toBeChecked();

  // Disable the whole medium group and confirm the next scan reports no medium findings.
  await mediumMasterReopened.uncheck();
  await page.click('#secConfigBtn'); // close
  await page.click('#secScanBtn');
  await expect(page.locator('#secStatus')).not.toHaveText('Scanning…', { timeout: 5_000 });
  await expect(page.locator('.sec-group-label.sec-medium')).toHaveCount(0);

  // Restore full state for later tests in this file.
  await page.click('#secConfigBtn');
  await page.locator('.sec-config-group', { has: page.locator('.sec-config-group-label.sec-medium') })
    .locator('.sec-config-group-label input').check();
  await page.click('#secConfigBtn');
  await page.click('#secScanBtn');
  await expect(page.locator('#secStatus')).not.toHaveText('Scanning…', { timeout: 5_000 });

  expect(mediumCount).toBeGreaterThan(1);
});
