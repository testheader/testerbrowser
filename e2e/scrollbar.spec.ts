/**
 * E2E tests for ticket #32 — scrollbar in always-available console.
 *
 * Verifies that #timelinePanel has a non-zero height after tab-switching,
 * which was broken when min-height: 0 was missing from the flex item.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';

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

test('timeline panel is visible on initial load', async () => {
  const panel = window.locator('#timelinePanel');
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThan(0);
});

test('timeline panel remains scrollable after switching tabs', async () => {
  // Switch to Storage tab then back to Console. switchConsoleTab() toggles
  // the tab buttons' "active" class and panel display synchronously, so
  // waiting for the button's own active state is a real (and immediate)
  // signal rather than a guess at how long the switch takes.
  await window.click('#consoleTabStorage');
  await expect(window.locator('#consoleTabStorage')).toHaveClass(/active/);
  await window.click('#consoleTabConsole');
  await expect(window.locator('#consoleTabConsole')).toHaveClass(/active/);

  const panel = window.locator('#timelinePanel');
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  // Height must be > 0, proving min-height: 0 allows overflow-y to take effect
  expect(box!.height).toBeGreaterThan(0);
});

test('timeline panel wrapper is visible after multiple tab switches', async () => {
  for (const tab of ['#consoleTabStorage', '#consoleTabA11y', '#consoleTabConsole']) {
    await window.click(tab);
    await expect(window.locator(tab)).toHaveClass(/active/);
  }

  const wrapper = window.locator('#timelinePanelWrapper');
  await expect(wrapper).toBeVisible();
  const box = await wrapper.boundingBox();
  expect(box!.height).toBeGreaterThan(10);
});
