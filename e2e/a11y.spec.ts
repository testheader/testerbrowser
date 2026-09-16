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

test('Violations view finds real axe-core issues via Refresh (#193)', async () => {
  const urlPath = '/accessibility/violations.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await getTabPage(app, urlPath);

  await window.click('#consoleTabA11y');
  await window.click('#a11yViewViolationsBtn');
  await window.click('#a11yRefreshBtn');

  const content = window.locator('#a11yContent');
  // button-name (the empty <button>) and aria-roles (role="bogus-role") —
  // neither overlaps the rules #194/#195/#196 own, so both should surface
  // here. (duplicate-id was tried first, but axe-core 4.13 deprecated it —
  // disabled by default — so it never actually fired; button-name is on by
  // default and unrelated to any excluded rule.)
  await expect(content).toContainText('button-name', { timeout: 10_000 });
  await expect(content).toContainText('aria-roles');
});

test('Contrast view lists failing/unknown-background elements but not fully-passing ones (#194)', async () => {
  const urlPath = '/accessibility/contrast.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await getTabPage(app, urlPath);

  await window.click('#consoleTabA11y');
  await window.click('#a11yViewContrastBtn');
  await window.click('#a11yRefreshBtn');

  const content = window.locator('#a11yContent');
  // Fails AA outright (~1.4:1 on white).
  await expect(content).toContainText('Low contrast text that fails AA', { timeout: 10_000 });
  // Text over a background-image — flagged unknown, not scored.
  await expect(content).toContainText('Text over a background image, not a solid color');
  // Fully passes AA and AAA — should not appear anywhere in the results.
  await expect(content).not.toContainText('Normal contrast text that passes AA and AAA');
});

test('Structure view lists headings/landmarks in document order and flags a heading skip + missing <main> (#195)', async () => {
  const urlPath = '/accessibility/structure.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await getTabPage(app, urlPath);

  await window.click('#consoleTabA11y');
  await window.click('#a11yViewStructureBtn');
  await window.click('#a11yRefreshBtn');

  const content = window.locator('#a11yContent');
  await expect(content).toContainText('Page title', { timeout: 10_000 });
  await expect(content).toContainText('Skipped heading (no h2 in between)');
  // The h1 → h3 jump is flagged inline on the skipped heading's own row.
  await expect(content).toContainText('jumped from H1 to H3');
  // banner/navigation/contentinfo landmarks are present…
  await expect(content).toContainText('banner');
  await expect(content).toContainText('navigation');
  await expect(content).toContainText('contentinfo');
  // …but there's deliberately no <main>, which should be flagged.
  await expect(content).toContainText('No <main> landmark found');
});

test('Alt & Labels view flags exactly the missing-alt image and the bare input (#196)', async () => {
  const urlPath = '/accessibility/alt-labels.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await getTabPage(app, urlPath);

  await window.click('#consoleTabA11y');
  await window.click('#a11yViewAltLabelsBtn');
  await window.click('#a11yRefreshBtn');

  const content = window.locator('#a11yContent');
  await expect(content).toContainText('missing-alt.png', { timeout: 10_000 });
  await expect(content).toContainText('input#a11yInputBare');

  // The five labeled/excluded cases never appear anywhere in the results.
  await expect(content).not.toContainText('decorative.png');
  await expect(content).not.toContainText('logo.png');
  await expect(content).not.toContainText('a11yInputWrapped');
  await expect(content).not.toContainText('a11yInputFor');
  await expect(content).not.toContainText('a11yInputArialabel');
  await expect(content).not.toContainText('a11yInputLabelledby');
});

test('Focus order overlay computes tab order (positive tabindex first) and flags a missing focus indicator (#197)', async () => {
  const urlPath = '/accessibility/focus-order.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await getTabPage(app, urlPath);

  await window.click('#consoleTabA11y');
  await window.click('#a11yFocusOrderBtn');

  const content = window.locator('#a11yContent');
  await expect(content).toContainText('First in tab order', { timeout: 10_000 });

  // Relative order, not absolute numbers — the shared fixture-nav crumb link
  // is also naturally focusable and sorts in with tabindex=0 elements.
  const rows = content.locator('.a11y-structure-row');
  const rowTexts = await rows.allTextContents();
  const idx1 = rowTexts.findIndex(t => t.includes('First in tab order'));
  const idx2 = rowTexts.findIndex(t => t.includes('Second in tab order'));
  const idxNoOutline = rowTexts.findIndex(t => t.includes('no focus style'));
  expect(idx1).toBeGreaterThanOrEqual(0);
  expect(idx2).toBeGreaterThan(idx1);
  expect(idxNoOutline).toBeGreaterThan(idx2);

  await expect(rows.nth(idxNoOutline)).toContainText('no visible focus indicator');
  await expect(rows.nth(idx1)).not.toContainText('no visible focus indicator');
  await expect(rows.nth(idx2)).not.toContainText('no visible focus indicator');

  await window.click('#a11yFocusOrderBtn');
  await expect(window.locator('#a11yFocusOrderBtn')).not.toHaveClass(/on/);
});
