import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getActiveViewBounds, getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
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

test('the "Compare against" picker sits between Capture baseline and Compare, and view buttons are on their own row', async () => {
  await window.click('#consoleTabVR');
  const rows = window.locator('.vr-toolbar-row');
  await expect(rows).toHaveCount(2);

  const captureRow = rows.nth(0);
  await expect(captureRow).toContainText('Capture');
  const captureRowElements = captureRow.locator('#vrCaptureBtn, #vrComparePick, #vrCompareBtn');
  await expect(captureRowElements).toHaveCount(3);
  // Order within the row: capture button, then the compare-against picker, then Compare.
  const ids = await captureRow.locator('button, select').evaluateAll(els => els.map(el => el.id));
  expect(ids.indexOf('vrCaptureBtn')).toBeLessThan(ids.indexOf('vrComparePick'));
  expect(ids.indexOf('vrComparePick')).toBeLessThan(ids.indexOf('vrCompareBtn'));

  const viewRow = rows.nth(1);
  await expect(viewRow).toContainText('View');
  await expect(viewRow.locator('#vrViews')).toBeVisible();
});

test('capturing a baseline, mutating the page, and comparing reports a nonzero diff', async () => {
  const urlPath = '/performance/heavy-dom.html?count=50';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, 'heavy-dom.html');

  await window.click('#consoleTabVR');
  await window.click('#vrCaptureBtn');
  await expect(window.locator('#vrStats')).toContainText('Baseline captured', { timeout: 10_000 });

  await tab.click('#render');

  await window.click('#vrCompareBtn');
  await expect(window.locator('#vrStats')).toContainText('pixels differ', { timeout: 15_000 });

  const statsText = (await window.locator('#vrStats').textContent()) || '';
  const match = statsText.match(/^([\d,]+) pixels differ/);
  expect(match).toBeTruthy();
  expect(Number(match![1].replace(/,/g, ''))).toBeGreaterThan(0);
});

test('comparing against a different session captures that session\'s screenshot, not the baseline session\'s own (#127)', async () => {
  const urlPath = '/performance/heavy-dom.html?count=50';

  const sessionsBefore = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const baselineSessionId = sessionsBefore[sessionsBefore.length - 1].id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), baselineSessionId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const baselineTab = await getTabPage(app, 'heavy-dom.html');

  await window.click('#consoleTabVR');
  await window.click('#vrCaptureBtn');
  await expect(window.locator('#vrStats')).toContainText('Baseline captured', { timeout: 10_000 });

  // A second, unrelated session navigated to the same page and then mutated —
  // if Compare still screenshots the baseline session itself (the pre-#127
  // bug), it'll capture the unmutated page and report ~0 diff.
  await window.click('#newSessionBtn');
  const sessionsAfter = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const otherSessionId = sessionsAfter.find((s: { id: string }) => s.id !== baselineSessionId
    && !sessionsBefore.some((b: { id: string }) => b.id === s.id)).id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), otherSessionId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const otherTab = await getTabPage(app, 'heavy-dom.html', baselineTab);
  await otherTab.click('#render');

  // Switch back to the baseline session via a real tab click — unlike
  // testerBrowser.sessions.switchTo() (a raw IPC call to the main process
  // only), clicking a tab also updates the renderer's own notion of the
  // active session, which activeData()/getActiveId() (and so the VR panel)
  // depend on.
  await window.click(`.tab[data-id="${baselineSessionId}"] .tab-name`);
  await window.click('#consoleTabVR');
  await expect(window.locator('#vrCompareBtn')).toBeEnabled();
  await window.selectOption('#vrComparePick', otherSessionId);

  await window.click('#vrCompareBtn');
  await expect(window.locator('#vrStats')).toContainText('pixels differ', { timeout: 15_000 });

  const statsText = (await window.locator('#vrStats').textContent()) || '';
  const match = statsText.match(/^([\d,]+) pixels differ/);
  expect(match).toBeTruthy();
  expect(Number(match![1].replace(/,/g, ''))).toBeGreaterThan(0);
});

test('a baseline and current screenshot of different sizes show a visible size-mismatch warning (#238)', async () => {
  const urlPath = '/network/status-codes.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, urlPath)).waitForLoadState('load');

  await window.click('#consoleTabVR');
  // Full page stays unchecked, so the capture is a viewport screenshot —
  // its dimensions track the app window's size.
  await window.click('#vrCaptureBtn');
  await expect(window.locator('#vrStats')).toContainText('Baseline captured', { timeout: 10_000 });

  const boundsBeforeResize = await getActiveViewBounds(app);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(900, 700); });
  // Wait for the BrowserView's own bounds to actually reflect the new window
  // size (sessionManager's 'resize' handler re-layouts it) instead of
  // guessing how long that settling takes.
  await expect.poll(async () => (await getActiveViewBounds(app))?.width).not.toBe(boundsBeforeResize?.width);

  await window.click('#vrCompareBtn');
  await expect(window.locator('#vrStats')).toContainText('pixels differ', { timeout: 15_000 });
  await expect(window.locator('#vrStats')).toContainText('Image sizes differ');
  // The existing diff stat is still shown alongside the warning, not replaced by it.
  await expect(window.locator('#vrStats')).toContainText('% of');

  // Restore the window size so later tests in this file see the usual layout.
  const boundsBeforeRestore = await getActiveViewBounds(app);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1400, 900); });
  await expect.poll(async () => (await getActiveViewBounds(app))?.width).not.toBe(boundsBeforeRestore?.width);
});

test('the Compare button re-enables after a failed screenshot instead of staying stuck on "Comparing…" (#238)', async () => {
  // This drives the pre-existing "Screenshot failed" early-return path
  // (captureScreenshot resolving null for a session that doesn't exist),
  // which already re-enabled the button correctly before this ticket — it's
  // not a regression test for the loadImage()/onerror fix itself. That fix
  // addresses a *different*, narrower failure mode (a captured screenshot
  // that decodes to a broken image) which isn't reachable from here:
  // contextBridge-exposed methods can't be monkeypatched from the page
  // (confirmed empirically — reassigning
  // testerBrowser.visualRegression.captureScreenshot from window.evaluate is
  // a silent no-op), and no fixture route naturally produces a corrupt
  // screenshot capture. Kept anyway as a general regression guard on the
  // button/stats recovery UX runCompare's try/catch/finally is responsible
  // for, since that's the same machinery the real fix depends on.
  await window.click('#consoleTabVR');
  await expect(window.locator('#vrCompareBtn')).toBeEnabled();

  await window.evaluate(() => {
    const pick = document.getElementById('vrComparePick') as HTMLSelectElement;
    const opt = document.createElement('option');
    opt.value = 'nonexistent-session-id';
    pick.appendChild(opt);
    pick.value = 'nonexistent-session-id';
    pick.dispatchEvent(new Event('change'));
  });

  await window.click('#vrCompareBtn');
  await expect(window.locator('#vrCompareBtn')).toBeEnabled({ timeout: 10_000 });
  await expect(window.locator('#vrCompareBtn')).toHaveText('Compare');
  await expect(window.locator('#vrStats')).toContainText('Screenshot failed', { timeout: 10_000 });

  // Reset the picker back to its default for later tests.
  await window.selectOption('#vrComparePick', '');
});
