import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import { getMainWindow, getTabPage } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

let app: ElectronApplication;
let window: Page;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await electron.launch({
    args: [path.join(__dirname, '..', 'dist', 'main', 'index.js')],
  });
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

test('A11y tab button is present', async () => {
  await expect(window.locator('#consoleTabA11y')).toBeVisible();
});

test('Refresh loads a tree with expected roles and names', async () => {
  const urlPath = '/accessibility/index.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await getTabPage(app, urlPath);

  await window.click('#consoleTabA11y');
  await window.click('#a11yRefreshBtn');

  const content = window.locator('#a11yContent');
  await expect(content).toContainText('Save changes', { timeout: 10_000 });
  await expect(content).toContainText('Full name');
  // Most of the tree starts collapsed, so the matching row may not be
  // visible without expanding ancestors — just confirm it's in the DOM.
  await expect(content.locator('.a11y-role', { hasText: 'button' }).first()).toBeAttached();
});

test('Inspect element highlights and selects the hovered/clicked page element', async () => {
  const urlPath = '/accessibility/index.html';
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabA11y');
  await expect(window.locator('#a11yInspectBtn')).toBeEnabled();
  await window.click('#a11yInspectBtn');
  // setInspect() is fire-and-forget from the click handler — give the IPC
  // round-trip (CDP Accessibility.enable + injecting the hover listener) a
  // moment to land before generating page events for it to observe.
  await window.waitForTimeout(300);

  await tab.hover('[data-testid="a11y-button"]');
  await expect(window.locator('.a11y-row.a11y-hovered')).toContainText('Save changes', { timeout: 5_000 });

  await tab.click('[data-testid="a11y-button"]');
  await expect(window.locator('.a11y-row.a11y-selected')).toContainText('Save changes', { timeout: 5_000 });

  await window.click('#a11yInspectBtn');
  await expect(window.locator('#a11yInspectBtn')).not.toHaveClass(/on/);
});
