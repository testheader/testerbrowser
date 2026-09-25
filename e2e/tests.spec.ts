import fs from 'fs';
import os from 'os';
import path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH, wrapCloseForCleanup } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

let app: ElectronApplication;
let window: Page;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('domcontentloaded');

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

// ── #242: genSel names whichever data-* attribute actually matched ─────────

test('a click on a data-cy element records the selector [data-cy="..."], not [data-testid="..."] (#242)', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  await window.fill('#rpTestName', 'data-cy selector');
  await window.click('#rpStartBtn');

  await tab.click('[data-cy="submit"]');

  await window.click('#rpStopBtn');
  await expect(window.locator('#rpLiveSteps .rp-step-desc')).toHaveText('[data-cy="submit"]');

  await window.click('#rpSaveBtn');
  const testItem = window.locator('.rp-test-item', { hasText: 'data-cy selector' });
  await testItem.locator('.rp-test-expand').click();
  await expect(window.locator('.rp-saved-steps .rp-step-desc')).toHaveValue('[data-cy="submit"]');
  // Collapse again — an expanded saved test renders its own .rp-live-step
  // rows (renderSavedStepsHtml reuses that class), and later tests in this
  // file query that class unscoped, assuming nothing is left expanded.
  await testItem.locator('.rp-test-expand').click();
});

// ── #242: checkboxes/radios record as a boolean 'check' step, not 'fill' ───

test('recording check then uncheck replays back to the unchecked state, not "on" typed anywhere (#242)', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  await window.fill('#rpTestName', 'check uncheck');
  await window.click('#rpStartBtn');

  await tab.check('[data-testid="rp-checkbox"]');
  await tab.uncheck('[data-testid="rp-checkbox"]');

  await window.click('#rpStopBtn');

  // Each check()/uncheck() is its own real click, so — unlike fill's
  // keystroke coalescing — this records click, check(true), click,
  // check(false): 4 steps, not 1. What matters here is the *type* and
  // *value* the last one recorded, not a step count.
  const liveSteps = window.locator('#rpLiveSteps .rp-live-step');
  await expect(liveSteps).toHaveCount(4);
  await expect(liveSteps.last().locator('.rp-step-type')).toHaveText('uncheck ☐');

  await window.click('#rpSaveBtn');

  // Leave the checkbox checked before Run, so playback replaying "unchecked"
  // is a real, observable state change — not a no-op against the default.
  await tab.check('[data-testid="rp-checkbox"]');
  await expect(tab.locator('[data-testid="rp-checkbox"]')).toBeChecked();

  const testItem = window.locator('.rp-test-item', { hasText: 'check uncheck' });
  await testItem.locator('.rp-run-once').click();
  await expect(window.locator('#rpRunStatus')).toHaveText('All steps passed ✓', { timeout: 10_000 });
  await expect(tab.locator('[data-testid="rp-checkbox"]')).not.toBeChecked();
});

// ── #242: a password field's saved value is never typed literally ──────────

test('recording a password field masks the saved step, and Run prompts for the real value instead of typing "[hidden]" (#242)', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  await window.fill('#rpTestName', 'password field');
  await window.click('#rpStartBtn');

  await tab.fill('[data-testid="rp-password"]', 'super-secret-value');

  await window.click('#rpStopBtn');
  await expect(window.locator('#rpLiveSteps .rp-step-val')).toHaveText('[hidden]');

  await window.click('#rpSaveBtn');
  const testItem = window.locator('.rp-test-item', { hasText: 'password field' });
  await testItem.locator('.rp-test-expand').click();
  // The saved step's editable value field also never shows the real value —
  // rendered empty (masked), not the literal '[hidden]' text either.
  await expect(window.locator('.rp-saved-steps input[placeholder*="hidden"]')).toHaveValue('');
  // Collapse again — an expanded saved test renders its own .rp-live-step
  // rows (renderSavedStepsHtml reuses that class), and later tests in this
  // file query that class unscoped, assuming nothing is left expanded.
  await testItem.locator('.rp-test-expand').click();

  await testItem.locator('.rp-run-once').click();

  // Run pauses on an inline prompt for the real value instead of running
  // straight through and typing the placeholder into the field.
  const dlg = window.locator('#rpSensitiveDlg');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="password"]').fill('the-real-value');
  await dlg.locator('#rpSensitiveContinue').click();
  await expect(dlg).toBeHidden();

  await expect(window.locator('#rpRunStatus')).toHaveText('All steps passed ✓', { timeout: 10_000 });
  await expect(tab.locator('[data-testid="rp-password"]')).toHaveValue('the-real-value');
});

// ── #224: the 600ms poll must merge, not replace, currentSteps ─────────────

test('deleting a step mid-recording keeps it removed as new steps keep arriving (#224)', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  await window.fill('#rpTestName', 'merge test');
  await window.click('#rpStartBtn');

  // Three distinct actions: fill, click, fill again — a click in between
  // keeps the two fills from coalescing into one step.
  await tab.fill('[data-testid="rp-input"]', 'Ada');
  await tab.click('[data-testid="rp-btn"]');
  await tab.fill('[data-testid="rp-input"]', 'Bob');

  const liveSteps = window.locator('.rp-live-step');
  await expect.poll(() => liveSteps.count(), { timeout: 5_000 }).toBe(3);

  // Delete step index 1 — the click — leaving the two fills.
  await window.locator('.rp-del-step[data-idx="1"]').click();
  await expect(liveSteps).toHaveCount(2);
  const typesAfterDelete = await liveSteps.locator('.rp-step-type').allTextContents();
  expect(typesAfterDelete).toEqual(['fill', 'fill']);

  // One more action while still recording — the next poll tick must append
  // only this new step, not resurrect the deleted click by replacing
  // currentSteps wholesale with the main process's full (still 3-item, now
  // 4-item) buffer.
  await tab.click('[data-testid="rp-btn"]');
  await expect.poll(() => liveSteps.count(), { timeout: 5_000 }).toBe(3);

  const typesFinal = await liveSteps.locator('.rp-step-type').allTextContents();
  expect(typesFinal).toEqual(['fill', 'fill', 'click']);

  await window.click('#rpStopBtn');
  await window.click('#rpDiscardBtn');
});

test('a recording started on one tab keeps polling and stops on that tab, even if another tab is active at Stop (#224)', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tabA = await getTabPage(app, urlPath);

  const tabAId = await window.locator('.tab.active').getAttribute('data-id');

  await window.click('#consoleTabTests');
  await window.fill('#rpTestName', 'wrong tab test');
  await window.click('#rpStartBtn');

  await tabA.fill('[data-testid="rp-input"]', 'FromTabA');
  await tabA.click('[data-testid="rp-btn"]');
  await expect.poll(() => window.locator('.rp-live-step').count(), { timeout: 5_000 }).toBe(2);

  // Switch to a different tab (tab B) while the recording keeps running.
  await window.keyboard.press('Control+t');
  await expect(window.locator('.tab.active')).not.toHaveAttribute('data-id', tabAId as string);
  const tabBId = await window.locator('.tab.active').getAttribute('data-id');

  // One more real action on tab A — proves the poll is still tracking A,
  // not silently stuck because getActiveId() now points at B.
  await tabA.fill('[data-testid="rp-input"]', 'StillTabA');
  await expect.poll(() => window.locator('.rp-live-step').count(), { timeout: 5_000 }).toBe(3);

  await window.click('#rpStopBtn');
  const finalSteps = window.locator('.rp-live-step');
  await expect(finalSteps).toHaveCount(3);
  const values = await finalSteps.locator('.rp-step-val').allTextContents();
  expect(values).toContain('FromTabA');
  expect(values).toContain('StillTabA');

  await window.click('#rpDiscardBtn');

  // Close tab B and restore tab A as active — otherwise this test leaves an
  // extra tab open (and B, not A, active), which makes getTabPage's
  // URL-substring match ambiguous for every test after this one in the file.
  await window.locator(`.tab[data-id="${tabBId}"]`).click();
  await window.keyboard.press('Control+w');
  await window.locator(`.tab[data-id="${tabAId}"]`).click();
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

// ── Step-by-step playback mode (#158) ────────────────────────────────────────

test('step-by-step mode pauses after each step, highlights it, and Next advances', async () => {
  await window.click('#consoleTabTests');
  const testItem = window.locator('.rp-test-item', { hasText: 'fill and click' });
  await expect(testItem).toBeVisible();
  await expect(testItem.locator('.rp-test-meta')).toHaveText('2 steps');

  await window.check('#rpStepModeToggle');
  await testItem.locator('.rp-run-once').click();

  // First step runs immediately on Run, then pauses — Next/Stop appear and
  // the just-run step is highlighted as current.
  await expect(window.locator('#rpRunStatus')).toHaveText('Paused after step 1/2 — click Next to continue', { timeout: 10_000 });
  await expect(window.locator('#rpStepControls')).toBeVisible();
  const firstRow = window.locator('.rp-step-row').nth(0);
  await expect(firstRow).toHaveClass(/rp-step-current/);
  await expect(firstRow).toHaveClass(/rp-step-pass/);
  // The second (final) step hasn't run yet.
  await expect(window.locator('.rp-step-row')).toHaveCount(1);

  await window.click('#rpNextStepBtn');

  await expect(window.locator('#rpRunStatus')).toHaveText('All steps passed ✓', { timeout: 10_000 });
  await expect(window.locator('#rpStepControls')).toBeHidden();
  await expect(window.locator('.rp-step-row')).toHaveCount(2);
  const secondRow = window.locator('.rp-step-row').nth(1);
  await expect(secondRow).toHaveClass(/rp-step-current/);

  await window.uncheck('#rpStepModeToggle');
});

test('Stop ends step-by-step playback cleanly without running the remaining steps', async () => {
  await window.click('#consoleTabTests');
  const testItem = window.locator('.rp-test-item', { hasText: 'fill and click' });

  await window.check('#rpStepModeToggle');
  await testItem.locator('.rp-run-once').click();

  await expect(window.locator('#rpRunStatus')).toHaveText('Paused after step 1/2 — click Next to continue', { timeout: 10_000 });
  await window.click('#rpStopStepBtn');

  await expect(window.locator('#rpRunStatus')).toHaveText('Stopped after step 1/2');
  await expect(window.locator('#rpStepControls')).toBeHidden();
  // The second step never ran.
  await expect(window.locator('.rp-step-row')).toHaveCount(1);

  await window.uncheck('#rpStepModeToggle');
});

test('step-by-step toggle has no effect on "Run N×" — repeat runs stay continuous', async () => {
  await window.click('#consoleTabTests');
  const testItem = window.locator('.rp-test-item', { hasText: 'fill and click' });

  await window.check('#rpStepModeToggle');
  await testItem.locator('.rp-repeat-input').fill('2');
  await testItem.locator('.rp-run-many').click();

  await expect(window.locator('.rp-repeat-header')).toContainText('STABLE', { timeout: 15_000 });
  await expect(window.locator('#rpStepControls')).toBeHidden();

  await window.uncheck('#rpStepModeToggle');
});

// ── Selector confidence indicator (#160) ─────────────────────────────────────

test('recorded steps show a confidence dot that turns red after navigating away, since the selectors no longer match', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  await window.click('#rpStartBtn');
  await tab.fill('[data-testid="rp-input"]', 'Ada');
  await tab.click('[data-testid="rp-btn"]');
  await window.click('#rpStopBtn');

  // Both recorded selectors ([data-testid="rp-input"] and [...="rp-btn"]) are
  // unique on the page they were recorded against.
  const dots = window.locator('#rpLiveSteps .rp-confidence-dot');
  await expect(dots).toHaveCount(2);
  await expect(dots.nth(0)).toHaveClass(/rp-confidence-green/, { timeout: 5_000 });
  await expect(dots.nth(1)).toHaveClass(/rp-confidence-green/);
  await expect(dots.nth(0)).toHaveAttribute('title', /unique and reliable/);

  // Navigating the same tab elsewhere leaves those selectors matching
  // nothing — the indicator should catch that without needing a re-run.
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/console/logs.html'));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, '/console/logs.html')).waitForLoadState('load');

  await expect(dots.nth(0)).toHaveClass(/rp-confidence-red/, { timeout: 5_000 });
  await expect(dots.nth(1)).toHaveClass(/rp-confidence-red/);
  await expect(dots.nth(0)).toHaveAttribute('title', /broken/);

  await window.click('#rpDiscardBtn');
});

// ── Editing and deleting steps of a saved test (#162) ───────────────────────

test('a saved test can be expanded to show its steps with type, selector and value', async () => {
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabTests');
  await window.fill('#rpTestName', 'editable steps target');
  await window.click('#rpStartBtn');
  await tab.fill('[data-testid="rp-input"]', 'Ada');
  await tab.click('[data-testid="rp-btn"]');
  await window.click('#rpStopBtn');
  await window.click('#rpSaveBtn');

  const testItem = window.locator('.rp-test-item', { hasText: 'editable steps target' });
  await expect(testItem).toBeVisible();
  await expect(testItem.locator('.rp-saved-steps')).toHaveCount(0);

  await testItem.locator('.rp-test-expand').click();
  const rows = testItem.locator('.rp-saved-steps .rp-live-step');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.rp-step-type')).toHaveValue('fill');
  await expect(rows.nth(0).locator('.rp-step-desc')).toHaveValue('[data-testid="rp-input"]');
  await expect(rows.nth(0).locator('.rp-step-val')).toHaveValue('Ada');
  await expect(rows.nth(1).locator('.rp-step-type')).toHaveValue('click');
  await expect(rows.nth(1).locator('.rp-step-desc')).toHaveValue('[data-testid="rp-btn"]');
});

test('editing a step\'s selector inline breaks the run, and correcting it fixes the run — without duplicating the saved test', async () => {
  await window.click('#consoleTabTests');
  const testItem = window.locator('.rp-test-item', { hasText: 'editable steps target' });
  const selectorInput = testItem.locator('.rp-saved-steps .rp-live-step').nth(0).locator('.rp-step-desc');

  await selectorInput.fill('[data-testid="does-not-exist"]');
  await selectorInput.blur();

  await testItem.locator('.rp-run-once').click();
  await expect(window.locator('#rpRunStatus')).toContainText('Failed at step 1', { timeout: 15_000 });

  // Editing in place must not create a second entry for the same test.
  await expect(window.locator('.rp-test-item', { hasText: 'editable steps target' })).toHaveCount(1);

  await selectorInput.fill('[data-testid="rp-input"]');
  await selectorInput.blur();

  await testItem.locator('.rp-run-once').click();
  await expect(window.locator('#rpRunStatus')).toHaveText('All steps passed ✓', { timeout: 10_000 });
});

test('a failed step renders a click-to-enlarge thumbnail and a readable error line naming the selector (#185)', async () => {
  await window.click('#consoleTabTests');
  const testItem = window.locator('.rp-test-item', { hasText: 'editable steps target' });
  const selectorInput = testItem.locator('.rp-saved-steps .rp-live-step').nth(0).locator('.rp-step-desc');

  await selectorInput.fill('[data-testid="does-not-exist"]');
  await selectorInput.blur();

  await testItem.locator('.rp-run-once').click();
  await expect(window.locator('#rpRunStatus')).toContainText('Failed at step 1', { timeout: 15_000 });

  // The error is its own readable line, not just squeezed into the status
  // cell, and names the selector that couldn't be found.
  const errorLine = window.locator('.rp-step-error');
  await expect(errorLine).toBeVisible();
  await expect(errorLine).toContainText('[data-testid="does-not-exist"]');

  // Bounded thumbnail, not the whole run column's width.
  const shot = window.locator('.rp-failure-shot');
  await expect(shot).toBeVisible();
  const shotBox = (await shot.boundingBox())!;
  expect(shotBox.height).toBeLessThanOrEqual(140);

  // Click to enlarge: the overlay opens with that exact image, not a blank
  // or re-captured one (the page has moved on by the time this fires).
  await shot.click();
  await expect(window.locator('#imageOverlay')).toHaveClass(/open/);
  const overlayImg = window.locator('#imageOverlayImg');
  await expect(overlayImg).toBeVisible();
  const src = await overlayImg.getAttribute('src');
  expect(src).toMatch(/^data:image\/png;base64,.+/);

  await window.keyboard.press('Escape');
  await expect(window.locator('#imageOverlay')).not.toHaveClass(/open/);

  // Restore the step — later tests reuse this same saved test.
  await selectorInput.fill('[data-testid="rp-input"]');
  await selectorInput.blur();
});

test('deleting a step from a saved test updates the step count and the removed action no longer executes', async () => {
  // Fresh navigation resets the fixture's DOM state so a stale #rp-result
  // from an earlier run in this file can't be mistaken for the click step
  // actually having fired here.
  const urlPath = '/record/target.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');
  await expect(tab.locator('[data-testid="rp-result"]')).toHaveAttribute('data-status', 'idle');

  await window.click('#consoleTabTests');
  const testItem = window.locator('.rp-test-item', { hasText: 'editable steps target' });
  await expect(testItem.locator('.rp-test-meta')).toHaveText('2 steps');

  const clickStepRow = testItem.locator('.rp-saved-steps .rp-live-step').nth(1);
  await clickStepRow.locator('.rp-saved-step-del').click();

  await expect(testItem.locator('.rp-test-meta')).toHaveText('1 steps');
  await expect(testItem.locator('.rp-saved-steps .rp-live-step')).toHaveCount(1);

  await testItem.locator('.rp-run-once').click();
  await expect(window.locator('#rpRunStatus')).toHaveText('All steps passed ✓', { timeout: 10_000 });

  // The fill step still ran (the input carries the recorded value)...
  await expect(tab.locator('[data-testid="rp-input"]')).toHaveValue('Ada');
  // ...but the deleted click step did not: the page's own click handler
  // never fired, so its side effects never happened.
  await expect(tab.locator('[data-testid="rp-result"]')).toHaveAttribute('data-status', 'idle');
  await expect(tab.locator('[data-testid="rp-counter"]')).toHaveText('0');
});

// ── Column layout (#183) ────────────────────────────────────────────────────

test('the tab lays out as three columns: Record new test, Replay tests, then the run view', async () => {
  await window.click('#consoleTabTests');
  const recordCol = window.locator('#rpRecordCol');
  const savedCol  = window.locator('#rpSavedCol');
  const mainCol   = window.locator('.rp-main');
  await expect(recordCol).toContainText('Record New Test');
  await expect(savedCol).toContainText('Replay Tests');
  await expect(mainCol).toBeVisible();

  const recordBox = (await recordCol.boundingBox())!;
  const savedBox  = (await savedCol.boundingBox())!;
  const mainBox   = (await mainCol.boundingBox())!;
  expect(recordBox.x).toBeLessThan(savedBox.x);
  expect(savedBox.x).toBeLessThan(mainBox.x);
});

test('dragging the splitter resizes the Replay tests column, clamped at its minimum when dragged far past it', async () => {
  const savedCol  = window.locator('#rpSavedCol');
  const splitter2 = window.locator('#rpSplitter2');

  const before = (await savedCol.boundingBox())!;
  const handle = (await splitter2.boundingBox())!;
  const y = handle.y + handle.height / 2;

  await window.mouse.move(handle.x + handle.width / 2, y);
  await window.mouse.down();
  await window.mouse.move(handle.x + handle.width / 2 - 60, y, { steps: 5 });
  await window.mouse.up();

  const afterShrink = (await savedCol.boundingBox())!;
  expect(afterShrink.width).toBeCloseTo(before.width - 60, 0);

  // Drag it far past the minimum — clamps there instead of shrinking further
  // (or, worse, going to zero/negative).
  const handle2 = (await splitter2.boundingBox())!;
  await window.mouse.move(handle2.x + handle2.width / 2, y);
  await window.mouse.down();
  await window.mouse.move(handle2.x - 2000, y, { steps: 5 });
  await window.mouse.up();

  const clamped = (await savedCol.boundingBox())!;
  expect(clamped.width).toBeGreaterThanOrEqual(280);
  expect(clamped.width).toBeLessThan(afterShrink.width);
});

test('column widths persist across a restart', async () => {
  // A dedicated instance sharing one profile dir across two sequential
  // launches — unlike the file's shared `app`/`window`, which uses its own
  // isolated profile and would otherwise carry settings between test files.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-e2e-rp-'));

  const app1 = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
  const win1 = await getMainWindow(app1);
  await win1.waitForLoadState('load');
  await win1.click('#consoleTabTests');

  const handle = (await win1.locator('#rpSplitter1').boundingBox())!;
  const y = handle.y + handle.height / 2;
  await win1.mouse.move(handle.x + handle.width / 2, y);
  await win1.mouse.down();
  await win1.mouse.move(handle.x + handle.width / 2 + 50, y, { steps: 5 });
  await win1.mouse.up();

  const resizedWidth = (await win1.locator('#rpRecordCol').boundingBox())!.width;
  // The width write is an async settings:set IPC round-trip, not something
  // mouseup itself waits for, and a restart below reads only from the
  // persisted settings.json — poll that file directly until the write has
  // actually landed, instead of guessing how long the round-trip takes.
  const settingsPath = path.join(userDataDir, 'settings.json');
  await expect.poll(() => {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return raw?.recordPlaybackColumnWidths?.record;
    } catch {
      return undefined;
    }
  }, { timeout: 5_000 }).not.toBeUndefined();
  await app1.close();

  const app2 = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
  // Only the second (last) launch's close should remove the shared profile
  // dir — app1's own close above must leave it in place for app2 to reuse.
  wrapCloseForCleanup(app2, [userDataDir]);
  const win2 = await getMainWindow(app2);
  await win2.waitForLoadState('load');
  await win2.click('#consoleTabTests');

  const restoredWidth = (await win2.locator('#rpRecordCol').boundingBox())!.width;
  expect(restoredWidth).toBeCloseTo(resizedWidth, 0);

  await app2.close();
});
