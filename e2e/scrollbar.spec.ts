/**
 * E2E tests for ticket #32 — scrollbar in always-available console.
 *
 * Verifies that #timelinePanel has a non-zero height after tab-switching,
 * which was broken when min-height: 0 was missing from the flex item.
 */

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';

let app: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [path.join(__dirname, '..', 'dist', 'main', 'index.js')],
  });
  window = await app.firstWindow();
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
  // Switch to Storage tab then back to Console
  await window.click('#consoleTabStorage');
  await window.waitForTimeout(300);
  await window.click('#consoleTabConsole');
  await window.waitForTimeout(300);

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
    await window.waitForTimeout(200);
  }

  const wrapper = window.locator('#timelinePanelWrapper');
  await expect(wrapper).toBeVisible();
  const box = await wrapper.boundingBox();
  expect(box!.height).toBeGreaterThan(10);
});
