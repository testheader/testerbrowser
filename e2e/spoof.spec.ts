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

// getTabPage can resolve while the tab's frame is mid-navigation (observed as
// an intermittent "Execution context was destroyed" from page.evaluate right
// after a fresh navigation) — retry briefly instead of asserting once.
async function retryEvaluate<T>(page: Page, fn: () => T): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < 10; i++) {
    try {
      return await page.evaluate(fn);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw lastErr;
}

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

test('switching tabs repopulates the panel fields with the newly active session\'s own overrides', async () => {
  const sessions = await window.evaluate(() => (window as unknown as { testerBrowser: { sessions: { list(): Promise<{ id: string }[]> } } }).testerBrowser.sessions.list());
  const sessionAId = sessions[0].id;

  await window.click(`.tab[data-id="${sessionAId}"] .tab-name`);
  await window.click('#consoleTabSpoof');
  for (const id of ['#spoofTimezone', '#spoofLocale', '#spoofLat', '#spoofLon']) {
    await window.fill(id, '');
  }
  await window.fill('#spoofTimezone', 'Asia/Tokyo');
  await window.fill('#spoofLocale', 'ja-JP');
  await window.click('#spoofApply');
  await expect(window.locator('#spoofStatus')).toContainText('Overrides applied', { timeout: 5_000 });
  await expect(window.locator('#spoofDirty')).toBeHidden();

  await window.click('#newSessionBtn');
  const allSessions = await window.evaluate(() => (window as unknown as { testerBrowser: { sessions: { list(): Promise<{ id: string }[]> } } }).testerBrowser.sessions.list());
  const sessionBId = allSessions.find((s) => s.id !== sessionAId)!.id;
  await window.click(`.tab[data-id="${sessionBId}"] .tab-name`);

  // Session B has no overrides: fields must clear and the summary must say
  // so, not silently keep showing A's values under B's name.
  await expect(window.locator('#spoofCurrent')).toContainText('No overrides applied', { timeout: 5_000 });
  await expect(window.locator('#spoofTimezone')).toHaveValue('');
  await expect(window.locator('#spoofLocale')).toHaveValue('');
  await expect(window.locator('#spoofDirty')).toBeHidden();

  await window.click(`.tab[data-id="${sessionAId}"] .tab-name`);

  // Switching back to A must show A's own values — not B's, and not stale
  // text left over from before A's overrides were applied — and must not
  // flag them as unapplied edits.
  await expect(window.locator('#spoofTimezone')).toHaveValue('Asia/Tokyo', { timeout: 5_000 });
  await expect(window.locator('#spoofLocale')).toHaveValue('ja-JP');
  await expect(window.locator('#spoofDirty')).toBeHidden();

  await window.click('#spoofReset');
  await expect(window.locator('#spoofStatus')).toContainText('Overrides cleared', { timeout: 5_000 });
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

test('a user-agent preset overrides navigator.userAgent and the request header, and clearing restores the default', async () => {
  // webContents.setUserAgent() (unlike the Emulation-domain overrides above)
  // is a direct Electron API, not scoped to a separate CDP debugger session,
  // so it genuinely is observable through Playwright's own page.evaluate()
  // and through the real request header the fixture server receives.
  const urlPath = '/network/status-codes.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');

  // getTabPage can resolve microtasks before its own navigation has fully
  // settled (observed as an intermittent "Execution context was destroyed"),
  // so retry evaluate() a couple of times rather than asserting once.
  const realUa = await retryEvaluate(tab, () => navigator.userAgent);

  await window.click('#consoleTabSpoof');
  await window.selectOption('#spoofUaPresets', { label: 'Android Chrome' });
  const androidUa = await window.locator('#spoofUserAgent').inputValue();
  expect(androidUa).toContain('Android');

  await window.click('#spoofApply');
  await expect(window.locator('#spoofStatus')).toContainText('Overrides applied', { timeout: 5_000 });
  await expect(window.locator('#spoofCurrent')).toContainText('UA', { timeout: 5_000 });

  await expect.poll(() => tab.evaluate(() => navigator.userAgent), { timeout: 10_000 }).toBe(androidUa);

  const echoUrl = fixtures.url('/echo/user-agent');
  const body = await tab.evaluate((url) => fetch(url).then((r) => r.json()), echoUrl);
  expect((body as { userAgent: string }).userAgent).toBe(androidUa);

  // Client Hints metadata must agree with the spoofed UA, not silently keep
  // reporting the real browser.
  const uaData = await retryEvaluate(tab, () =>
    (navigator as unknown as { userAgentData?: { mobile: boolean; platform: string } }).userAgentData
  );
  if (uaData) {
    expect(uaData.mobile).toBe(true);
    expect(uaData.platform).toBe('Android');
  }

  // Clearing the field and re-applying restores the default UA (a distinct
  // path from the Reset button, per the ticket's explicit acceptance criterion).
  await window.fill('#spoofUserAgent', '');
  await window.click('#spoofApply');
  await expect(window.locator('#spoofStatus')).toContainText('Overrides applied', { timeout: 5_000 });
  await expect.poll(() => tab.evaluate(() => navigator.userAgent), { timeout: 10_000 }).toBe(realUa);

  // Reset overrides also restores the default UA.
  await window.selectOption('#spoofUaPresets', { label: 'Googlebot' });
  await window.click('#spoofApply');
  await expect(window.locator('#spoofStatus')).toContainText('Overrides applied', { timeout: 5_000 });
  await expect.poll(() => tab.evaluate(() => navigator.userAgent), { timeout: 10_000 }).toContain('Googlebot');

  await window.click('#spoofReset');
  await expect(window.locator('#spoofStatus')).toContainText('Overrides cleared', { timeout: 5_000 });
  await expect.poll(() => tab.evaluate(() => navigator.userAgent), { timeout: 10_000 }).toBe(realUa);
});

test('the user-agent presets are a dropdown grouped by optgroup, including this browser\'s own UA, and hand-editing falls back to Custom (#184)', async () => {
  await window.click('#consoleTabSpoof');
  const uaSelect = window.locator('#spoofUaPresets');
  await expect(uaSelect).toHaveJSProperty('tagName', 'SELECT');

  const groups = await uaSelect.locator('optgroup').evaluateAll(
    els => els.map(el => (el as HTMLOptGroupElement).label)
  );
  expect(groups).toEqual(expect.arrayContaining(['This browser', 'Desktop', 'Mobile', 'Bots']));

  const labels = await uaSelect.locator('option').allTextContents();
  expect(labels).toEqual(expect.arrayContaining([
    'Custom / none', 'TesterBrowser (this app)', 'Chrome (Windows)', 'Firefox (Windows)',
    'Safari (macOS)', 'Edge (Windows)', 'iOS Safari', 'Android Chrome', 'Android 8 (older)',
    'Googlebot', 'Bingbot',
  ]));

  // "This browser" uses the chrome window's own live navigator.userAgent,
  // not a hardcoded string that would rot on the next Electron bump.
  const ownUa = await window.evaluate(() => navigator.userAgent);
  await window.selectOption('#spoofUaPresets', { label: 'TesterBrowser (this app)' });
  await expect(window.locator('#spoofUserAgent')).toHaveValue(ownUa);

  // Selecting a different preset still fills the field as before.
  await window.selectOption('#spoofUaPresets', { label: 'Chrome (Windows)' });
  await expect(window.locator('#spoofUserAgent')).toHaveValue(/Chrome\/124/);
  await expect(uaSelect).toHaveValue(/.+/); // a real preset index, not "" (Custom)

  // Hand-editing the field afterwards switches the dropdown back to Custom.
  await window.fill('#spoofUserAgent', 'MyCustomAgent/1.0');
  await expect(uaSelect).toHaveValue('');
});
