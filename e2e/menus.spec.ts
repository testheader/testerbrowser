/**
 * Regression coverage for the app-menu / View ▾ dropdown overlay (see
 * layout.js beginPageOverlay/endPageOverlay, sessionManager.ts
 * beginPageOverlay/endPageOverlay): opening either dropdown must snapshot
 * and detach the active session's native view rather than pushing it down,
 * so the page never reflows, and must restore the exact same bounds on close.
 *
 * Run with: npm run test:e2e
 * Requires: npm run build (or npm run dev) first.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getActiveViewBounds, getMainWindow, launchApp, MAIN_PATH } from './helpers';

let app: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
});

async function assertOverlayBehaviour(openBtnSelector: string, dropdownSelector: string) {
  const before = await getActiveViewBounds(app);
  expect(before).not.toBeNull();

  await window.click(openBtnSelector);
  await expect(window.locator(dropdownSelector)).toHaveClass(/open/);

  // #pageSnapshot only becomes visible once the main process has confirmed
  // the view is detached (see layout.js beginPageOverlay), so waiting for it
  // is also the synchronization point for the assertions below.
  const snapshot = window.locator('#pageSnapshot');
  await expect(snapshot).toBeVisible();

  // The view is genuinely detached, not just covered — no bounds to report.
  expect(await getActiveViewBounds(app)).toBeNull();

  // The snapshot standing in for it covers exactly where the view was, so
  // nothing about the page's apparent position or size changes.
  const snapshotBox = await snapshot.boundingBox();
  expect(snapshotBox).toMatchObject({ x: before!.x, y: before!.y, width: before!.width, height: before!.height });

  await window.click(openBtnSelector);
  await expect(window.locator(dropdownSelector)).not.toHaveClass(/open/);
  // endPageOverlay reattaches the view before hiding the snapshot (see
  // layout.js), so waiting for the snapshot to disappear is the
  // synchronization point for the reattachment itself.
  await expect(snapshot).toBeHidden();

  expect(await getActiveViewBounds(app)).toEqual(before);
}

test('app menu overlays the page without reflowing or losing the view\'s bounds', async () => {
  await assertOverlayBehaviour('#appName', '#appMenuDropdown');
});

test('View dropdown overlays the page without reflowing or losing the view\'s bounds', async () => {
  await assertOverlayBehaviour('#viewBtn', '#viewDropdown');
});

// ── #177: dismissing the dropdowns ──────────────────────────────────────────
//
// With the view detached (see above), the only thing painted where the page
// used to be is #pageSnapshot — plain chrome HTML, not a native view — so a
// click there reaches the chrome document like any other click and is
// dismissed by app-menu.js / view-dropdown.js's existing outside-click
// listener. That click is not forwarded to the real page: it's fully
// detached and has nothing to receive it while the overlay is up.

test('clicking the page (the snapshot standing in for it) closes the app menu', async () => {
  await window.click('#appName');
  const snapshot = window.locator('#pageSnapshot');
  await expect(snapshot).toBeVisible();

  await snapshot.click();
  await expect(window.locator('#appMenuDropdown')).not.toHaveClass(/open/);
  await expect(snapshot).toBeHidden();
});

test('clicking the page closes the View dropdown', async () => {
  await window.click('#viewBtn');
  const snapshot = window.locator('#pageSnapshot');
  await expect(snapshot).toBeVisible();

  await snapshot.click();
  await expect(window.locator('#viewDropdown')).not.toHaveClass(/open/);
  await expect(snapshot).toBeHidden();
});

test('Escape closes the app menu and the View dropdown', async () => {
  await window.click('#appName');
  await expect(window.locator('#appMenuDropdown')).toHaveClass(/open/);
  await window.keyboard.press('Escape');
  await expect(window.locator('#appMenuDropdown')).not.toHaveClass(/open/);

  await window.click('#viewBtn');
  await expect(window.locator('#viewDropdown')).toHaveClass(/open/);
  await window.keyboard.press('Escape');
  await expect(window.locator('#viewDropdown')).not.toHaveClass(/open/);
});

test('opening one dropdown closes the other', async () => {
  await window.click('#appName');
  await expect(window.locator('#appMenuDropdown')).toHaveClass(/open/);

  await window.click('#viewBtn');
  await expect(window.locator('#viewDropdown')).toHaveClass(/open/);
  await expect(window.locator('#appMenuDropdown')).not.toHaveClass(/open/);

  await window.click('#appName');
  await expect(window.locator('#appMenuDropdown')).toHaveClass(/open/);
  await expect(window.locator('#viewDropdown')).not.toHaveClass(/open/);

  // Leave both closed for later tests.
  await window.click('#appName');
  await expect(window.locator('#appMenuDropdown')).not.toHaveClass(/open/);
});

test('clicking the chrome (outside either dropdown) still closes the app menu', async () => {
  await window.click('#appName');
  await expect(window.locator('#appMenuDropdown')).toHaveClass(/open/);

  // The empty titlebar-drag region — chrome, not part of either dropdown,
  // and (unlike a button) has no side effect of its own to worry about.
  await window.click('#titlebarDrag');
  await expect(window.locator('#appMenuDropdown')).not.toHaveClass(/open/);
});
