import fs from 'fs';
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

interface AxeViolation {
  id: string;
  impact?: string;
  help: string;
  nodes: { target: string[] }[];
}

const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf-8');

// index.html's CSP (script-src 'self', no 'unsafe-inline'/'unsafe-eval')
// blocks both addScriptTag's inline injection and page-side eval — CDP's
// Runtime.evaluate isn't subject to a page's own CSP at all (the same
// reasoning e2e/a11y.spec.ts documents for the app's own A11y panel, which
// injects axe-core into a *target* page's CSP this same way), so run axe
// through a raw CDP session instead of Playwright's page-script helpers.
async function scanForViolations(win: Page): Promise<AxeViolation[]> {
  const cdp = await win.context().newCDPSession(win);
  try {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(function() {\n${AXE_SOURCE}\nreturn axe.run();\n})()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return (result.value as { violations: AxeViolation[] }).violations;
  } finally {
    await cdp.detach();
  }
}

function seriousOrCritical(violations: AxeViolation[]): AxeViolation[] {
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

// Failure output names every offending node's selector, not just the rule
// id — the point of this gate is to say exactly what to go fix.
function describeViolations(violations: AxeViolation[]): string {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`)
    .join('\n\n');
}

// #256: TesterBrowser ships an A11y panel that audits *other* pages' own
// accessibility (e2e/a11y.spec.ts) — this is the standing regression gate
// proving its own chrome meets the same bar. Scoped to the chrome window
// (index.html) only, via a direct Playwright addScriptTag/evaluate against
// `window` — a loaded tab's own page content lives in a separate native
// WebContentsView layered on top of this document, entirely out of its
// DOM, so nothing here needs excluding for that reason.
test('the chrome UI has no serious/critical axe-core violations (dark theme, the default)', async () => {
  const violations = seriousOrCritical(await scanForViolations(window));
  expect(violations, describeViolations(violations)).toEqual([]);
});

test('the chrome UI has no serious/critical axe-core violations (light theme)', async () => {
  // The light theme is applied via a body class (renderer/theme.js's
  // applyTheme()), toggled through the real Settings UI here rather than by
  // poking the class directly, so this also exercises the actual selection
  // path a tester would use.
  await window.click('#appName');
  await window.click('#appMenuSettings');
  await expect(window.locator('#settingsOverlay')).toHaveClass(/open/);
  await window.selectOption('#themeSelect', 'light');
  await expect(window.locator('body')).toHaveClass(/light-mode/);
  await window.click('#closeSettingsBtn');

  const violations = seriousOrCritical(await scanForViolations(window));
  expect(violations, describeViolations(violations)).toEqual([]);
});

// The two tests above only scan whatever's visible on the default Console
// tab — every other console-panel tab (Storage, A11y, Diff, Mock, Jira, …)
// is `display:none` at that point, and axe skips elements that aren't
// rendered. Contrast/name/role bugs specific to a tab's own markup (e.g. a
// button whose color token only got fixed for one theme) would pass both
// tests above unnoticed. Cycle through every console tab, in light theme
// (the theme most likely to have missed token pairs — see CLAUDE.md's
// Gotchas), scanning each one once it's the visible panel.
const CONSOLE_TABS = [
  'consoleTabConsole', 'consoleTabNetwork', 'consoleTabStorage', 'consoleTabA11y',
  'consoleTabDiff', 'consoleTabVR', 'consoleTabSpoof', 'consoleTabSecurity',
  'consoleTabMock', 'consoleTabResilience', 'consoleTabJira', 'consoleTabTests',
  'consoleTabFollow', 'consoleTabDebugLog',
];

test('every console panel tab has no serious/critical axe-core violations (light theme)', async () => {
  await window.click('#appName');
  await window.click('#appMenuSettings');
  await expect(window.locator('#settingsOverlay')).toHaveClass(/open/);
  await window.selectOption('#themeSelect', 'light');
  await expect(window.locator('body')).toHaveClass(/light-mode/);
  await window.click('#closeSettingsBtn');

  const allViolations: AxeViolation[] = [];
  for (const tabId of CONSOLE_TABS) {
    await window.click(`#${tabId}`);
    await window.waitForTimeout(100); // panel-specific init (initJira, initMock, …) is fire-and-forget
    const violations = seriousOrCritical(await scanForViolations(window));
    for (const v of violations) allViolations.push({ ...v, help: `[${tabId}] ${v.help}` });
  }
  expect(allViolations, describeViolations(allViolations)).toEqual([]);
});
