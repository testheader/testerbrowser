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
  // setInspect() is fire-and-forget from the click handler (CDP
  // Accessibility.enable + injecting the hover listener) — there's no
  // renderer-side signal for when that IPC round-trip actually lands, so
  // retry the hover itself until it's observed instead of guessing how long
  // it takes.
  await expect(async () => {
    await tab.hover('[data-testid="a11y-button"]');
    await expect(window.locator('.a11y-row.a11y-hovered')).toContainText('Save changes', { timeout: 500 });
  }).toPass({ timeout: 5_000 });

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

test('Violations view shows an error, not "No violations found", when the audit fails to run (#222)', async () => {
  // CDP's Runtime.evaluate (what the Violations audit's axe-core injection
  // uses) isn't itself subject to the page's own CSP — DevTools evaluation
  // needs to keep working regardless of what a page's CSP forbids — so a
  // strict-CSP fixture page can't actually reproduce a failed audit here.
  // contextBridge-exposed APIs are frozen too (see shortcuts.spec.ts's F3
  // test), so patching window.testerBrowser.a11y.getViolations from the
  // renderer side is out as well. Patch the real main-process CDP debugger
  // instead — the same technique that test uses for webContents.findInPage
  // — so this exercises the actual getA11yViolations() catch branch, the
  // real IPC round trip, and the real renderer, not a fake response.
  const urlPath = '/accessibility/index.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');

  const patched = await app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
    if (!wc) return false;
    const original = wc.debugger.sendCommand.bind(wc.debugger);
    (wc as unknown as { __origSendCommand: unknown }).__origSendCommand = original;
    (wc.debugger as unknown as { sendCommand: unknown }).sendCommand = (method: string, params: unknown) => {
      if (method === 'Runtime.evaluate') return Promise.reject(new Error('Simulated CDP failure (e2e stub)'));
      return original(method, params);
    };
    return true;
  }, tab.url());
  expect(patched).toBe(true);

  try {
    await window.click('#consoleTabA11y');
    await window.click('#a11yViewViolationsBtn');
    await window.click('#a11yRefreshBtn');

    const content = window.locator('#a11yContent');
    await expect(content).toContainText('Accessibility audit failed: Simulated CDP failure (e2e stub)', { timeout: 10_000 });
    await expect(content).not.toContainText('No violations found');
  } finally {
    // Restore the real debugger for later tests in this file.
    await app.evaluate(({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
      if (!wc) return;
      const original = (wc as unknown as { __origSendCommand: unknown }).__origSendCommand;
      (wc.debugger as unknown as { sendCommand: unknown }).sendCommand = original;
    }, tab.url());
  }
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

test('highlighting a contrast finding lands on the exact element for a non-identifier id, and restores its own outline afterward (#239)', async () => {
  const urlPath = '/accessibility/contrast.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');

  // A colon in the id is legal HTML but not a bare CSS identifier — the old
  // unescaped `tag + '#' + el.id` selectorFor would either throw or resolve
  // to the wrong element. An inline outline exercises the highlight's
  // restore path (it used to hardcode outline: '' instead of putting this
  // back).
  //
  // On some CI runners 'load' can resolve for a transitional navigation
  // state just before the real document commits, so the very next
  // evaluate() can still race a context teardown ("Execution context was
  // destroyed") even though the URL already matched — retry past that
  // exactly like the highlight assertions below already do.
  await expect(async () => {
    await tab.evaluate(() => {
      const el = document.querySelector('[data-testid="a11y-contrast-low"]') as HTMLElement;
      el.id = 'a:b';
      el.style.outline = '2px dashed blue';
    });
  }).toPass({ timeout: 5_000 });

  await window.click('#consoleTabA11y');
  await window.click('#a11yViewContrastBtn');
  await window.click('#a11yRefreshBtn');

  const content = window.locator('#a11yContent');
  await expect(content).toContainText('Low contrast text that fails AA', { timeout: 10_000 });

  const row = content.locator('.a11y-contrast-row', { hasText: 'Low contrast text that fails AA' });
  await row.click();

  // The highlight actually landed on #a:b — not silently failed (a thrown,
  // unescaped selector) and not some other tag+class match on the page.
  await expect(async () => {
    const outline = await tab.evaluate(() => document.getElementById('a:b')?.style.outline);
    expect(outline).toContain('255, 82, 82'); // #ff5252
  }).toPass({ timeout: 3_000 });

  // Once the highlight's own 2s timeout fires, the element's original
  // outline comes back — not cleared to nothing.
  await expect(async () => {
    const outline = await tab.evaluate(() => document.getElementById('a:b')?.style.outline);
    expect(outline).toContain('dashed');
    expect(outline).not.toContain('255, 82, 82');
  }).toPass({ timeout: 4_000 });
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

test('Focus trap detector flags a deliberate trap and names the trapped elements (#198)', async () => {
  const urlPath = '/accessibility/focus-trap.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await getTabPage(app, urlPath);

  await window.click('#consoleTabA11y');
  await window.click('#a11yFocusTrapBtn');

  const content = window.locator('#a11yContent');
  // The walk sends real, sequential CDP key events (up to 2×N per
  // direction) — give it real time to finish rather than the usual 10s.
  await expect(content).toContainText('Focus trap', { timeout: 20_000 });
  await expect(content).toContainText('button#a11yTrapA');
  await expect(content).toContainText('button#a11yTrapB');
  await expect(content).toContainText('button#a11yTrapC');
});

test('Focus trap detector reports no trap on a clean page (#198)', async () => {
  const urlPath = '/accessibility/index.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await getTabPage(app, urlPath);

  await window.click('#consoleTabA11y');
  await window.click('#a11yFocusTrapBtn');

  const content = window.locator('#a11yContent');
  await expect(content).toContainText('No focus trap detected', { timeout: 20_000 });
  // Both directions (Forward and Backward) should report clean, not just one.
  await expect(content.locator('.a11y-empty', { hasText: 'No focus trap detected' })).toHaveCount(2);
});
