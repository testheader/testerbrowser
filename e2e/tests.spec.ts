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
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(1000);

  // Record Playback used to validate with alert()/prompt() — a native dialog
  // this harness never dismisses would hang any test that hits one. Guarding
  // the whole file, not just one test, proves the inline-status refactor
  // reaches every call site (#150).
  window.on('dialog', () => { throw new Error('Unexpected native dialog opened'); });
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

test('Tests tab button exists in console panel', async () => {
  const btn = window.locator('#consoleTabTests');
  await expect(btn).toBeAttached();
});

test('clicking Tests tab shows testsPanel', async () => {
  await window.locator('#consoleTabTests').click();
  await expect(window.locator('#testsPanel')).toBeVisible();
});

test('testsPanel contains Start recording button', async () => {
  await window.locator('#consoleTabTests').click();
  await expect(window.locator('#rpStartBtn')).toBeAttached();
});

test('testsPanel contains test list section', async () => {
  await window.locator('#consoleTabTests').click();
  await expect(window.locator('#rpTestList')).toBeAttached();
});

// ── Real record → save → run cycle ──────────────────────────────────────────

test('recording a fill + click and running it back actually replays successfully', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  await window.fill('#rpTestName', 'fill and click');
  await window.click('#rpStartBtn');

  // Interact on the tab's own page — the recorder captures real DOM events,
  // not synthetic ones injected from the chrome side.
  await tab.fill('[data-testid="rp-input"]', 'Ada');
  await tab.click('[data-testid="rp-btn"]');

  await window.click('#rpStopBtn');
  await window.click('#rpSaveBtn');

  const testItem = window.locator('.rp-test-item', { hasText: 'fill and click' });
  await expect(testItem).toBeVisible();
  // One fill + one click — consecutive keystrokes on the same field coalesce
  // into a single step, so this should be exactly 2, not one-per-keystroke.
  await expect(testItem.locator('.rp-test-meta')).toHaveText('2 steps');

  await testItem.locator('.rp-run-once').click();
  await expect(window.locator('#rpRunStatus')).toHaveText('All steps passed ✓', { timeout: 10_000 });
});

// ── assert-attr: field-name bug (step.attrValue vs step.value) ──────────────

// Dispatches a synthetic contextmenu event at a fixed, known-on-screen
// position rather than a real right-click at the row's own coordinates —
// showAssertionMenu() positions the popup at event.clientX/clientY with no
// viewport-bounds clamping, so right-clicking a row lower in the list can
// place the menu partly off-screen and unclickable in a small test window.
async function openAssertionMenu(rowIdx: number) {
  const row = window.locator(`.rp-live-step[data-idx="${rowIdx}"]`);
  await row.dispatchEvent('contextmenu', { clientX: 60, clientY: 60, bubbles: true });
}

async function addAssertAttrStep(afterStepIdx: number, selector: string, attr: string, value: string) {
  await openAssertionMenu(afterStepIdx);
  await window.locator('.rp-assert-menu-item', { hasText: 'Assert: attribute equals' }).click();
  await window.fill('#rpAssertSel', selector);
  await window.fill('#rpAssertAttr', attr);
  await window.fill('#rpAssertVal', value);
  await window.click('#rpAssertOk');
}

test('assert-attr passes when the expected value matches the live attribute', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  await window.fill('#rpTestName', 'assert-attr passes');
  await window.click('#rpStartBtn');
  await tab.fill('[data-testid="rp-input"]', 'Ada');
  await tab.click('[data-testid="rp-btn"]');
  await window.click('#rpStopBtn');

  // The click handler sets data-status="clicked" on #rp-result — a real,
  // known attribute value to assert against.
  await addAssertAttrStep(1, '[data-testid="rp-result"]', 'data-status', 'clicked');
  await expect(window.locator('.rp-live-step[data-idx="2"]')).toContainText('assert-attr');

  await window.click('#rpSaveBtn');
  const testItem = window.locator('.rp-test-item', { hasText: 'assert-attr passes' });
  await testItem.locator('.rp-run-once').click();
  await expect(window.locator('#rpRunStatus')).toHaveText('All steps passed ✓', { timeout: 10_000 });
});

test('assert-attr fails when the expected value does not match', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  await window.fill('#rpTestName', 'assert-attr fails');
  await window.click('#rpStartBtn');
  await tab.fill('[data-testid="rp-input"]', 'Ada');
  await tab.click('[data-testid="rp-btn"]');
  await window.click('#rpStopBtn');

  await addAssertAttrStep(1, '[data-testid="rp-result"]', 'data-status', 'not-the-real-value');
  await window.click('#rpSaveBtn');

  const testItem = window.locator('.rp-test-item', { hasText: 'assert-attr fails' });
  await testItem.locator('.rp-run-once').click();
  await expect(window.locator('#rpRunStatus')).toContainText('Failed at step 3', { timeout: 10_000 });
});

// ── "Run N×" inline input ────────────────────────────────────────────────────

test('"Run N×" uses an inline number input with inline validation, not an OS prompt', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  const testItem = window.locator('.rp-test-item', { hasText: 'fill and click' });
  const repeatInput = testItem.locator('.rp-repeat-input');
  await expect(repeatInput).toHaveValue('10');

  await repeatInput.fill('0');
  await testItem.locator('.rp-run-many').click();
  await expect(repeatInput).toHaveClass(/rp-input-invalid/);
  // No native dialog fired (the listener above would have thrown) and the
  // invalid class is the only observable effect — runTest() was never called.

  await repeatInput.fill('3');
  await testItem.locator('.rp-run-many').click();
  await expect(repeatInput).not.toHaveClass(/rp-input-invalid/);
  await expect(window.locator('.rp-repeat-header')).toContainText('STABLE', { timeout: 15_000 });
  await expect(window.locator('.rp-repeat-summary')).toContainText('Runs: 3');
  await expect(window.locator('.rp-repeat-summary')).toContainText('Passed: 3');
});

// ── Repeat runs reset state between iterations (#145 fix 3) ─────────────────

test('a repeated run resets page state between iterations instead of accumulating it', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  await window.fill('#rpTestName', 'counter reset');
  await window.click('#rpStartBtn');
  await tab.click('[data-testid="rp-btn"]'); // first step is a click, not a navigate

  // #rp-counter increments on every click and never resets itself — without
  // reloading between repeat runs, run 2 would see "2" and run 3 "3", both
  // failing an assert-text expecting "1".
  await openAssertionMenu(0);
  await window.locator('.rp-assert-menu-item', { hasText: 'Assert: element contains text' }).click();
  await window.fill('#rpAssertSel', '[data-testid="rp-counter"]');
  await window.fill('#rpAssertVal', '1');
  await window.click('#rpAssertOk');

  await window.click('#rpStopBtn');
  await window.click('#rpSaveBtn');

  const testItem = window.locator('.rp-test-item', { hasText: 'counter reset' });
  await testItem.locator('.rp-repeat-input').fill('3');
  await testItem.locator('.rp-run-many').click();

  await expect(window.locator('.rp-repeat-header')).toContainText('STABLE', { timeout: 15_000 });
  await expect(window.locator('.rp-repeat-summary')).toContainText('Passed: 3');
  await expect(window.locator('.rp-repeat-summary')).toContainText('Failed: 0');
});

// ── Remaining alert()/prompt() dialogs replaced with inline status (#150) ───
// ("No active session"/"No steps recorded" guard branches in startRecording/
// saveRecordedTest/runTest are unreachable from the real UI — the buttons
// that call them are disabled whenever those conditions hold — so only the
// assertion dialog's validation, which real user input can actually trigger,
// has a meaningful UI-driven test here.)

test('the assertion dialog shows inline validation instead of alert() for a missing selector/value', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  await window.fill('#rpTestName', 'assertion validation');
  await window.click('#rpStartBtn');
  await tab.click('[data-testid="rp-btn"]');

  await openAssertionMenu(0);
  await window.locator('.rp-assert-menu-item', { hasText: 'Assert: element contains text' }).click();
  // Leave both the selector and value fields empty.
  await window.click('#rpAssertOk');
  await expect(window.locator('#rpAssertDlgStatus')).toHaveText('Selector required');
  await expect(window.locator('#rpAssertDlg')).toBeVisible(); // dialog stays open, unlike a dismissed alert()

  await window.fill('#rpAssertSel', '[data-testid="rp-result"]');
  await window.click('#rpAssertOk');
  await expect(window.locator('#rpAssertDlgStatus')).toHaveText('Value required');
  await expect(window.locator('#rpAssertDlg')).toBeVisible();

  await window.fill('#rpAssertVal', 'anything');
  await window.click('#rpAssertOk');
  await expect(window.locator('#rpAssertDlg')).toHaveCount(0);

  await window.click('#rpStopBtn');
  await window.click('#rpDiscardBtn');
});
