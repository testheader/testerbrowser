import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
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
  await (await getTabPage(app, urlPath)).waitForLoadState('load');

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
  await (await getTabPage(app, urlPath)).waitForLoadState('load');

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
  await (await getTabPage(app, urlPath)).waitForLoadState('load');

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

test('"Configure checks" is a cog that toggles open and closed indefinitely, and Escape closes it (#188)', async () => {
  await page.click('#consoleTabSecurity');

  const configBtn = page.locator('#secConfigBtn');
  const configEl  = page.locator('#secConfig');

  await expect(configBtn).toHaveAttribute('title', 'Configure checks');
  await expect(configBtn).toHaveText('⚙');
  await expect(configEl).toBeHidden();
  await expect(configBtn).not.toHaveClass(/active/);

  await configBtn.click();
  await expect(configEl).toBeVisible();
  await expect(configBtn).toHaveClass(/active/);

  await configBtn.click();
  await expect(configEl).toBeHidden();
  await expect(configBtn).not.toHaveClass(/active/);

  // Reopens again — not stuck closed after one open/close cycle.
  await configBtn.click();
  await expect(configEl).toBeVisible();
  await expect(configBtn).toHaveClass(/active/);

  // Escape closes it while open.
  await page.keyboard.press('Escape');
  await expect(configEl).toBeHidden();
  await expect(configBtn).not.toHaveClass(/active/);

  // A change made elsewhere (via settings directly) is reflected on reopen.
  await page.evaluate(async () => {
    const settings = await (window as any).testerBrowser.settings.get();
    await (window as any).testerBrowser.settings.set({
      securityRuleOverrides: { ...(settings.securityRuleOverrides ?? {}), 'http-unencrypted': false },
    });
  });
  await configBtn.click();
  const httpRuleCheckbox = page.locator('.sec-config-row', { hasText: 'HTTP (unencrypted)' }).locator('input');
  await expect(httpRuleCheckbox).not.toBeChecked();
  await httpRuleCheckbox.check(); // restore for other tests
  await configBtn.click();

  // Running a scan while the config is open doesn't close or corrupt it.
  await configBtn.click();
  await expect(configEl).toBeVisible();
  await page.click('#secScanBtn');
  await expect(page.locator('#secStatus')).not.toHaveText('Scanning…', { timeout: 5_000 });
  await expect(configEl).toBeVisible();
  await expect(page.locator('.sec-config-row')).not.toHaveCount(0);
  await configBtn.click();
});

// ── Document-only header rules, redaction/truncation banners (#240) ────────

test('header-presence findings name a Document response, not an Image response on the same host (#240)', async () => {
  // The fixture server is plain HTTP, and HEADER_PRESENCE_RULES/HEADER_VALUE_RULES
  // only ever apply to https:// URLs (pre-existing, unrelated to this ticket) —
  // so real fixture traffic can never reach them either way. Inject synthetic
  // Network.responseReceived CDP messages straight onto the tab's real
  // debugger EventEmitter (the same technique the #222 test above uses for a
  // branch that's otherwise unreachable through genuine traffic) to drive the
  // real recorder, IPC and renderer with a Document and an Image response
  // that both carry the same missing headers.
  const urlPath = '/network/status-codes.html';
  await page.click('#urlbar');
  await page.fill('#urlbar', fixtures.url(urlPath));
  await page.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');

  const docUrl = 'https://sec240.example.test/';
  const imgUrl = 'https://sec240.example.test/logo.png';
  const injected = await app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
    if (!wc) return false;
    wc.debugger.emit('message', {}, 'Network.responseReceived', {
      requestId: 'sec240-doc', type: 'Document',
      response: { url: 'https://sec240.example.test/', status: 200, headers: {} },
    });
    wc.debugger.emit('message', {}, 'Network.responseReceived', {
      requestId: 'sec240-img', type: 'Image',
      response: { url: 'https://sec240.example.test/logo.png', status: 200, headers: {} },
    });
    return true;
  }, tab.url());
  expect(injected).toBe(true);

  await page.click('#consoleTabSecurity');
  await page.click('#secScanBtn');
  await expect(page.locator('#secStatus')).not.toHaveText('Scanning…', { timeout: 5_000 });

  await expect(
    page.locator('.sec-row', { hasText: docUrl }).filter({ hasText: 'Missing x-frame-options' })
  ).toBeVisible();
  await expect(page.locator('.sec-row', { hasText: imgUrl })).toHaveCount(0);

  // The "Include subresources" toggle restores the old, type-blind behaviour.
  await page.click('#secConfigBtn');
  const subresourcesCheckbox = page.locator('.sec-config-subresources input');
  await expect(subresourcesCheckbox).not.toBeChecked();
  await subresourcesCheckbox.check();
  // The checkbox's own change handler persists via an async settings:set —
  // wait for it to actually land before scanning, rather than racing it.
  await expect.poll(async () => {
    const settings = await page.evaluate(() => (window as any).testerBrowser.settings.get());
    return settings.securityIncludeSubresources;
  }).toBe(true);
  await page.click('#secConfigBtn');

  await page.click('#secScanBtn');
  await expect(page.locator('#secStatus')).not.toHaveText('Scanning…', { timeout: 5_000 });
  await expect(
    page.locator('.sec-row', { hasText: imgUrl }).filter({ hasText: 'Missing x-frame-options' })
  ).toBeVisible();

  // Reset for later tests in this file.
  await page.click('#secConfigBtn');
  await subresourcesCheckbox.uncheck();
  await expect.poll(async () => {
    const settings = await page.evaluate(() => (window as any).testerBrowser.settings.get());
    return settings.securityIncludeSubresources;
  }).toBe(false);
  await page.click('#secConfigBtn');
});

test('cookie-redaction banner appears when a response carries a redacted set-cookie (#240)', async () => {
  // Chromium's Network domain never exposes Set-Cookie on Network.responseReceived
  // (only on the separate ...ExtraInfo event the recorder doesn't listen to —
  // see the "scan reports a real HTTP finding" test's own note above, and
  // #260), so a real page load can never produce a captured set-cookie value,
  // redacted or not, regardless of the redactSensitiveHeaders setting. Toggle
  // the real setting anyway (documents/exercises the intended real-world
  // trigger), then inject a synthetic already-redacted response the same way
  // the previous test does, since that's the only way to reach this specific
  // banner at all today.
  await page.evaluate(async () => {
    await (window as any).testerBrowser.settings.set({ redactSensitiveHeaders: true });
  });

  const urlPath = '/network/status-codes.html';
  await page.click('#urlbar');
  await page.fill('#urlbar', fixtures.url(urlPath));
  await page.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');

  const injected = await app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
    if (!wc) return false;
    wc.debugger.emit('message', {}, 'Network.responseReceived', {
      requestId: 'sec240-cookie', type: 'XHR',
      response: { url: 'https://sec240.example.test/api', status: 200, headers: { 'set-cookie': '[REDACTED]' } },
    });
    return true;
  }, tab.url());
  expect(injected).toBe(true);

  try {
    await page.click('#consoleTabSecurity');
    await page.click('#secScanBtn');
    await expect(page.locator('#secStatus')).not.toHaveText('Scanning…', { timeout: 5_000 });

    await expect(page.locator('.sec-banner', { hasText: 'Cookie rules skipped' })).toBeVisible();
  } finally {
    await page.evaluate(async () => {
      await (window as any).testerBrowser.settings.set({ redactSensitiveHeaders: false });
    });
  }
});
