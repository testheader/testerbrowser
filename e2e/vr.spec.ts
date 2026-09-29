import fs from 'fs';
import os from 'os';
import path from 'path';
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

test('the "Compare against" picker sits between Capture baseline and Compare, baselines and view controls are on their own rows', async () => {
  await window.click('#consoleTabVR');
  const rows = window.locator('.vr-toolbar-row');
  await expect(rows).toHaveCount(3);

  const captureRow = rows.nth(0);
  await expect(captureRow).toContainText('Capture');
  const captureRowElements = captureRow.locator('#vrCaptureBtn, #vrComparePick, #vrCompareBtn');
  await expect(captureRowElements).toHaveCount(3);
  // Order within the row: capture button, then the compare-against picker, then Compare.
  const ids = await captureRow.locator('button, select').evaluateAll(els => els.map(el => el.id));
  expect(ids.indexOf('vrCaptureBtn')).toBeLessThan(ids.indexOf('vrComparePick'));
  expect(ids.indexOf('vrComparePick')).toBeLessThan(ids.indexOf('vrCompareBtn'));

  const baselinesRow = rows.nth(1);
  await expect(baselinesRow).toContainText('Baselines');
  await expect(baselinesRow.locator('#vrBaselinePick')).toBeVisible();

  const viewRow = rows.nth(2);
  await expect(viewRow).toContainText('View');
  await expect(viewRow.locator('#vrViews')).toBeVisible();
  await expect(viewRow.locator('#vrThreshold')).toBeVisible();
  await expect(viewRow.locator('#vrEditRegionsBtn')).toBeVisible();
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

// ── Saved/named baselines, threshold, ignore regions (#277) ────────────────

test('saving a baseline persists it — it stays listed and loadable from a different, freshly opened tab (#277)', async () => {
  // A run-unique query string — several tests in this file navigate to
  // fixture pages under the same path, and leave the tab open afterward
  // (matching this file's existing convention); getTabPage() matches any
  // window whose URL merely *contains* the substring, so without this a
  // later getTabPage() call for the same path can resolve to an earlier
  // test's stale, inactive tab instead of the one just freshly navigated.
  const urlPath = `/vr/solid-color.html?nonce=${Date.now()}-save`;
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, urlPath)).waitForLoadState('load');

  await window.click('#consoleTabVR');
  await window.click('#vrCaptureBtn');
  await expect(window.locator('#vrStats')).toContainText('Baseline captured', { timeout: 10_000 });

  await window.click('#vrSaveBaselineBtn');
  await expect(window.locator('#vrSaveDlg')).toBeVisible();
  await window.fill('#vrSaveNameInput', 'e2e saved baseline');
  await window.click('#vrSaveDlgOk');
  await expect(window.locator('#vrBaselineStatus')).toContainText('Saved as "e2e saved baseline"');

  // A fresh tab has its own independent in-memory VR state (sessionData is
  // keyed per session) — finding and loading the baseline there proves it's
  // genuinely persisted on disk, not just still cached in the first tab's
  // own in-memory state.
  await window.click('#newSessionBtn');
  await window.click('#consoleTabVR');
  const option = window.locator('#vrBaselinePick option', { hasText: 'e2e saved baseline' });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute('value');
  await window.selectOption('#vrBaselinePick', value!);
  await window.click('#vrLoadBaselineBtn');
  await expect(window.locator('#vrBaselineStatus')).toContainText('Loaded "e2e saved baseline"');
  await expect(window.locator('#vrCompareBtn')).toBeEnabled();
  await expect(window.locator('#vrBaselineImg')).toBeVisible();

  // Close the extra tab this test opened — left open, it (and the earlier
  // ones opened by tests above) can leave getTabPage() with more than one
  // window matching a later test's URL substring, matching a stale tab
  // instead of the fresh one a later test just navigated.
  await window.keyboard.press('Control+w');
});

test('a higher pixel-difference threshold reports fewer (here, zero) differing pixels for the same comparison (#277)', async () => {
  const urlPath = `/performance/heavy-dom.html?count=50&nonce=${Date.now()}-threshold`;
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabVR');
  await window.click('#vrCaptureBtn');
  await expect(window.locator('#vrStats')).toContainText('Baseline captured', { timeout: 10_000 });
  await tab.click('#render');

  await window.click('#vrCompareBtn');
  await expect(window.locator('#vrStats')).toContainText('pixels differ', { timeout: 15_000 });
  const defaultText = (await window.locator('#vrStats').textContent()) || '';
  const defaultCount = Number(defaultText.match(/^([\d,]+) pixels differ/)![1].replace(/,/g, ''));
  expect(defaultCount).toBeGreaterThan(0);

  // 765 is the maximum possible |dr|+|dg|+|db| — strictly greater than that
  // is impossible, so this deterministically drives diffCount to exactly 0,
  // not just "fewer than before" (which a less extreme value would only
  // probabilistically guarantee against this fixture's actual colors).
  await window.fill('#vrThreshold', '765');
  await window.locator('#vrThreshold').dispatchEvent('change');
  await window.click('#vrCompareBtn');
  await expect(window.locator('#vrStats')).toContainText('pixels differ', { timeout: 15_000 });
  const lenientText = (await window.locator('#vrStats').textContent()) || '';
  const lenientCount = Number(lenientText.match(/^([\d,]+) pixels differ/)![1].replace(/,/g, ''));
  expect(lenientCount).toBe(0);
  expect(lenientCount).toBeLessThan(defaultCount);

  // Reset for later tests.
  await window.fill('#vrThreshold', '15');
  await window.locator('#vrThreshold').dispatchEvent('change');
});

test('drawing an ignore region excludes it from the diff count and renders it with the ignored tint, not the diff highlight (#277)', async () => {
  const urlPath = `/vr/solid-color.html?nonce=${Date.now()}-regions`;

  // The console panel defaults to a ~220px total height, most of which the
  // toolbar rows above the image already take up — the VR image's own
  // visible viewport ends up only tens of pixels tall, well short of the
  // image's actual rendered height. A drag computed against the image's
  // full (but mostly non-visible) bounding box would then dispatch at
  // screen coordinates below the actual window, hitting nothing. Grow the
  // panel first so the whole baseline image is genuinely on screen.
  const dragHandle = window.locator('#consoleDragHandle');
  const handleBox = (await dragHandle.boundingBox())!;
  await window.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await window.mouse.down();
  await window.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y - 500, { steps: 5 });
  await window.mouse.up();

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');

  await window.click('#consoleTabVR');
  await window.click('#vrCaptureBtn');
  await expect(window.locator('#vrStats')).toContainText('Baseline captured', { timeout: 10_000 });

  // The whole page changes color — essentially every pixel differs.
  await tab.click('#toggle');

  await window.click('#vrCompareBtn');
  await expect(window.locator('#vrStats')).toContainText('pixels differ', { timeout: 15_000 });
  const beforeText = (await window.locator('#vrStats').textContent()) || '';
  const beforeCount = Number(beforeText.match(/^([\d,]+) pixels differ/)![1].replace(/,/g, ''));
  expect(beforeCount).toBeGreaterThan(0);

  // Draw an ignore region over the bottom-right area of the baseline image
  // (away from the "toggle color" button in the top-left corner, so it's
  // purely solid-color pixels — a region that genuinely differs).
  await window.click('#vrEditRegionsBtn');
  const canvas = window.locator('#vrRegionsCanvas');
  // The canvas is sized off the <img>'s own rendered box (position:absolute;
  // inset:0 inside a wrapper whose height tracks the image) — reading
  // boundingBox() before the image has actually loaded and the browser has
  // laid it out would see a stale/zero-sized box.
  await expect(window.locator('#vrBaselineImg')).toBeVisible();
  const box = (await canvas.boundingBox())!;
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  await window.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55);
  await window.mouse.down();
  await window.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9, { steps: 5 });
  await window.mouse.up();
  await window.click('#vrEditRegionsBtn'); // exit edit mode

  await window.click('#vrCompareBtn');
  await expect(window.locator('#vrStats')).toContainText('pixels differ', { timeout: 15_000 });
  const afterText = (await window.locator('#vrStats').textContent()) || '';
  const afterCount = Number(afterText.match(/^([\d,]+) pixels differ/)![1].replace(/,/g, ''));
  expect(afterCount).toBeLessThan(beforeCount);

  // The rendered diff image shows the ignored-region tint (translucent
  // gray) at a point inside the drawn region, not the diff-red highlight a
  // real (non-ignored) difference there would otherwise get.
  await window.click('.vr-view-btn[data-view="diff"]');
  const diffSrc = await window.locator('.vr-img').getAttribute('src');
  const pixel = await window.evaluate(async (src) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src as string; });
    const canvas2 = document.createElement('canvas');
    canvas2.width = img.naturalWidth;
    canvas2.height = img.naturalHeight;
    const ctx = canvas2.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const x = Math.floor(img.naturalWidth * 0.7);
    const y = Math.floor(img.naturalHeight * 0.7);
    return Array.from(ctx.getImageData(x, y, 1, 1).data);
  }, diffSrc);
  expect(pixel[0]).toBeGreaterThan(100);
  expect(pixel[0]).toBeLessThan(200);
  expect(pixel[1]).toBeGreaterThan(100);
  expect(pixel[1]).toBeLessThan(200);
  expect(pixel[2]).toBeGreaterThan(100);
  expect(pixel[2]).toBeLessThan(200);

  // Shrink the console panel back down for later tests in this file.
  const handleBoxAfter = (await dragHandle.boundingBox())!;
  await window.mouse.move(handleBoxAfter.x + handleBoxAfter.width / 2, handleBoxAfter.y + handleBoxAfter.height / 2);
  await window.mouse.down();
  await window.mouse.move(handleBoxAfter.x + handleBoxAfter.width / 2, handleBoxAfter.y + 500, { steps: 5 });
  await window.mouse.up();
});

test('exporting then importing a saved baseline round-trips its name, dimensions and ignore regions (#277)', async () => {
  const urlPath = `/vr/solid-color.html?nonce=${Date.now()}-export`;
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, urlPath)).waitForLoadState('load');

  await window.click('#consoleTabVR');
  await window.click('#vrCaptureBtn');
  await expect(window.locator('#vrStats')).toContainText('Baseline captured', { timeout: 10_000 });
  await window.click('#vrSaveBaselineBtn');
  await window.fill('#vrSaveNameInput', 'e2e export-import baseline');
  await window.click('#vrSaveDlgOk');
  await expect(window.locator('#vrBaselineStatus')).toContainText('Saved as "e2e export-import baseline"');

  const tmpPath = path.join(os.tmpdir(), `testerbrowser-e2e-vr-baseline-${Date.now()}.png`);
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
  }, tmpPath);
  const savedId = await window.locator('#vrBaselinePick').inputValue();
  await window.click('#vrExportBaselineBtn');
  await expect.poll(() => fs.existsSync(tmpPath), { timeout: 5_000 }).toBe(true);
  const sidecarPath = tmpPath.replace(/\.png$/, '') + '.json';
  await expect.poll(() => fs.existsSync(sidecarPath), { timeout: 5_000 }).toBe(true);
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
  expect(sidecar).not.toHaveProperty('id');
  expect(sidecar.name).toBe('e2e export-import baseline');

  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [filePath] });
  }, tmpPath);
  await window.click('#vrImportBaselineBtn');
  await expect(window.locator('#vrBaselineStatus')).toContainText('Imported "e2e export-import baseline"');

  const options = window.locator('#vrBaselinePick option', { hasText: 'e2e export-import baseline' });
  await expect(options).toHaveCount(2); // the original saved one, plus the freshly imported copy
  const importedId = await options.evaluateAll((els, excludeId) =>
    (els as HTMLOptionElement[]).map((el) => el.value).find((v) => v !== excludeId), savedId);
  expect(importedId).toBeTruthy();
  expect(importedId).not.toBe(savedId);

  fs.rmSync(tmpPath, { force: true });
  fs.rmSync(sidecarPath, { force: true });
});
