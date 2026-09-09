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
