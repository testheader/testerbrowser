import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH, openNewSession } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

// The Rules panel (#370): Mock, Fail, Delay, Hang, Race and Rewrite are one
// ordered list per session, first match wins. (Race has its own spec.)

let app: ElectronApplication;
let window: Page;
let fixtures: FixtureServer;
let counter = 0;

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

/** A fresh session (rules are per partition) parked on the fixture API page, with a unique URL. */
async function openApiTab(win: Page = window, application: ElectronApplication = app): Promise<{ tab: Page; id: string; partition: string }> {
  const { id, partition } = await openNewSession(win);
  const urlPath = `/network/api.html?t=rules-${++counter}`;
  await win.click('#urlbar');
  await win.fill('#urlbar', fixtures.url(urlPath));
  await win.press('#urlbar', 'Enter');
  return { tab: await getTabPage(application, urlPath), id, partition };
}

/** Runs fetch(path) in the tab and returns { status, body } (or { error }). */
function pageFetch(tab: Page, urlPath: string, init?: { method?: string; body?: string }) {
  return tab.evaluate(async ({ p, i }) => {
    try {
      const r = await fetch(p, i);
      return { status: r.status, body: await r.text() };
    } catch (e) { return { error: String(e) }; }
  }, { p: urlPath, i: init });
}

async function openRulesNew(win: Page = window): Promise<void> {
  await win.click('#consoleTabRules');
  await win.click('#ruleNewBtn');
}

/** Step 1 (match) → step 2 (action chip) with the form left on step 2. */
async function matchAndPick(url: string, kind: string, win: Page = window): Promise<void> {
  await openRulesNew(win);
  await win.fill('#ruleUrl', url);
  await win.click('#ruleNextBtn');
  await win.click(`.rule-kind-chip[data-kind="${kind}"]`);
}

async function addMockViaUi(url: string, status: number, body: string, delayMs?: number): Promise<void> {
  await matchAndPick(url, 'mock');
  if (delayMs) await window.fill('#ruleDelay', String(delayMs));
  await window.click('#ruleNextBtn');
  await window.fill('#ruleMockStatus', String(status));
  await window.fill('#ruleMockBody', body);
  await window.click('#ruleAddBtn');
  await expect(window.locator('.rule-row', { hasText: url })).toBeVisible();
}

async function addFailViaUi(url: string, mode: string): Promise<void> {
  await matchAndPick(url, 'fail');
  await window.selectOption('#ruleFailMode', mode);
  await window.click('#ruleAddBtn');
  await expect(window.locator('.rule-row', { hasText: url })).toBeVisible();
}

async function addRuleViaIpc(sessionId: string, rule: Record<string, unknown>): Promise<void> {
  await window.evaluate(({ id, r }) => (window as any).testerBrowser.rules.addRule(id, r), { id: sessionId, r: rule });
}

async function rowOrder(): Promise<string[]> {
  return window.locator('.rule-row .rule-url').allTextContents();
}

test('the form starts closed; New rule opens it (pressed), Cancel and Esc close it', async () => {
  await window.click('#consoleTabRules');
  await expect(window.locator('#ruleForm')).toBeHidden();
  await expect(window.locator('#ruleNewBtn')).toHaveAttribute('aria-pressed', 'false');
  await window.click('#ruleNewBtn');
  await expect(window.locator('#ruleForm')).toBeVisible();
  await expect(window.locator('#ruleNewBtn')).toHaveAttribute('aria-pressed', 'true');
  await window.click('#ruleCancelBtn');
  await expect(window.locator('#ruleForm')).toBeHidden();
  await window.click('#ruleNewBtn');
  await window.press('#ruleUrl', 'Escape');
  await expect(window.locator('#ruleForm')).toBeHidden();
});

test('the stepper is match → action → details, and an action with nothing to configure skips the details step', async () => {
  await openRulesNew();
  await expect(window.locator('#ruleStepIndicator')).toHaveText('Step 1 of 3');
  await expect(window.locator('#ruleUrl')).toBeFocused();
  await expect(window.locator('#ruleNextBtn')).toBeDisabled();
  await window.fill('#ruleUrl', '*/api/stepper');
  await window.selectOption('#ruleMethod', 'GET');
  await window.fill('#ruleProb', '0');
  await expect(window.locator('#ruleNextBtn')).toBeDisabled();
  await window.fill('#ruleProb', '40');
  await expect(window.locator('#ruleNextBtn')).toBeEnabled();
  await window.press('#ruleUrl', 'Enter');

  // Mock (the default action) needs a details step.
  await expect(window.locator('#ruleStepIndicator')).toHaveText('Step 2 of 3');
  await expect(window.locator('#ruleKindChips .rule-kind-chip')).toHaveText(['Mock', 'Fail', 'Delay', 'Hang', 'Race', 'Rewrite']);
  await window.click('#ruleNextBtn');
  await expect(window.locator('#ruleStepIndicator')).toHaveText('Step 3 of 3');
  await expect(window.locator('#ruleSummary')).toHaveText('Mock 200 on GET `*/api/stepper`, 40% of requests');
  await window.fill('#ruleMockStatus', '99');
  await expect(window.locator('#ruleAddBtn')).toBeDisabled();
  await window.fill('#ruleMockStatus', '418');
  await expect(window.locator('#ruleAddBtn')).toBeEnabled();

  // Switch to Fail: the third step disappears, and Add is on step 2.
  await window.click('#ruleBackBtn');
  await window.click('.rule-kind-chip[data-kind="fail"]');
  await expect(window.locator('#ruleStepIndicator')).toHaveText('Step 2 of 2');
  await expect(window.locator('#ruleNextBtn')).toBeHidden();
  await expect(window.locator('#ruleAddBtn')).toBeEnabled();
  await window.click('.rule-kind-chip[data-kind="delay"]');
  await window.fill('#ruleDelay', '0');
  await expect(window.locator('#ruleAddBtn')).toBeDisabled(); // a delay rule needs a delay
  await window.press('#ruleDelay', 'Escape');
  await expect(window.locator('#ruleForm')).toBeHidden();
});

test('a Mock rule intercepts a matching fetch, shows its action and share, and its hit count increments', async () => {
  const { tab } = await openApiTab();
  await addMockViaUi('*/api/widgets', 201, '{"mocked":true}');
  const row = window.locator('.rule-row', { hasText: '/api/widgets' });
  await expect(row.locator('.rule-badge')).toHaveText('Mock 201');
  await expect(row.locator('.rule-prob')).toHaveText('100%');

  const out = await pageFetch(tab, '/api/widgets');
  expect(out).toMatchObject({ status: 201 });
  expect((out as { body: string }).body).toContain('"mocked":true');
  await expect(row.locator('.rule-hits-badge')).toHaveText('1', { timeout: 3_000 });
  await window.keyboard.press('Control+w');
});

test('Fail rules break the request in each way, and the response comes from the rule, not the server', async () => {
  const { tab } = await openApiTab();
  await addFailViaUi('*/fail/500', 'error500');
  await addFailViaUi('*/fail/404', 'missing');
  await addFailViaUi('*/fail/504', 'timeout');
  await addFailViaUi('*/fail/offline', 'offline');
  expect(await pageFetch(tab, '/fail/500')).toMatchObject({ status: 500, body: 'Internal Server Error' });
  expect(await pageFetch(tab, '/fail/404')).toMatchObject({ status: 404 });
  expect(await pageFetch(tab, '/fail/504')).toMatchObject({ status: 504 });
  expect(await pageFetch(tab, '/fail/offline')).toHaveProperty('error');
  await window.keyboard.press('Control+w');
});

test('a rule can be edited in place, and a disabled rule stops intercepting', async () => {
  const { tab } = await openApiTab();
  await addMockViaUi('*/api/edit-me', 200, 'one');
  const row = window.locator('.rule-row', { hasText: '/api/edit-me' });

  await row.locator('.rule-edit-btn').click();
  await expect(window.locator('#ruleFormTitle')).toHaveText('Edit rule');
  await expect(window.locator('#ruleUrl')).toHaveValue('*/api/edit-me');
  await window.click('#ruleNextBtn');
  await window.click('#ruleNextBtn');
  await expect(window.locator('#ruleMockBody')).toHaveValue('one');
  await window.fill('#ruleMockStatus', '202');
  await window.fill('#ruleMockBody', 'two');
  await window.click('#ruleAddBtn'); // "Save rule" in edit mode
  await expect(row.locator('.rule-badge')).toHaveText('Mock 202');
  expect(await pageFetch(tab, '/api/edit-me')).toMatchObject({ status: 202, body: 'two' });

  await row.locator('.rule-enable').uncheck();
  await expect(row).toHaveClass(/rule-row-disabled/);
  expect((await pageFetch(tab, '/api/edit-me') as { status: number }).status).not.toBe(202);
  await window.keyboard.press('Control+w');
});

test('a rule\'s delay holds the response back, with the mocked body', async () => {
  const { tab } = await openApiTab();
  await addMockViaUi('*/api/slow', 200, 'late', 900);
  const started = Date.now();
  expect(await pageFetch(tab, '/api/slow')).toMatchObject({ status: 200, body: 'late' });
  expect(Date.now() - started).toBeGreaterThanOrEqual(800);
  await expect(window.locator('.rule-row', { hasText: '/api/slow' }).locator('.rule-badge')).toHaveText('Mock 200, after 900 ms');
  await window.keyboard.press('Control+w');
});

test('a Delay rule lets the real response through after the wait; a Hang rule with "fail after" fails it', async () => {
  const { tab } = await openApiTab();
  await matchAndPick('*/network/status/200', 'delay');
  await window.fill('#ruleDelay', '700');
  await window.click('#ruleAddBtn');
  const started = Date.now();
  expect(await pageFetch(tab, '/network/status/200')).toMatchObject({ status: 200 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(600);

  await matchAndPick('*/network/status/201', 'hang');
  await window.fill('#ruleHangFailAfter', '1');
  await window.click('#ruleAddBtn');
  const hung = Date.now();
  expect(await pageFetch(tab, '/network/status/201')).toHaveProperty('error');
  expect(Date.now() - hung).toBeGreaterThanOrEqual(900);
  await window.keyboard.press('Control+w');
});

test('rules match top to bottom: ▲ and dragging change which rule wins', async () => {
  const { tab } = await openApiTab();
  await addMockViaUi('*/api/order*', 201, 'first');
  await addMockViaUi('*/api/order/*', 202, 'second');
  await addMockViaUi('*/api/orde?/x', 203, 'third');
  expect(await rowOrder()).toEqual(['*/api/order*', '*/api/order/*', '*/api/orde?/x']);
  expect(await pageFetch(tab, '/api/order/x')).toMatchObject({ status: 201 });

  await window.locator('.rule-row', { hasText: '*/api/order/*' }).locator('.rule-move-up-btn').click();
  await expect.poll(rowOrder).toEqual(['*/api/order/*', '*/api/order*', '*/api/orde?/x']);
  expect(await pageFetch(tab, '/api/order/x')).toMatchObject({ status: 202 });

  // Drag the last rule's handle onto the first row.
  const third = window.locator('.rule-row', { hasText: '*/api/orde?/x' });
  const first = window.locator('.rule-row').first();
  await third.locator('.rule-drag').dragTo(first);
  await expect.poll(rowOrder).toEqual(['*/api/orde?/x', '*/api/order/*', '*/api/order*']);
  expect(await pageFetch(tab, '/api/order/x')).toMatchObject({ status: 203 });
  await window.keyboard.press('Control+w');
});

test('a rule whose probability roll misses falls through to the next matching rule', async () => {
  const { tab, id } = await openApiTab();
  await addRuleViaIpc(id, { id: 'never', urlPattern: '*/api/prob*', method: '*', probability: 0, enabled: true,
    action: { kind: 'mock', statusCode: 500, body: 'never', responseHeaders: {} } });
  await addRuleViaIpc(id, { id: 'always', urlPattern: '*/api/prob*', method: '*', probability: 1, enabled: true,
    action: { kind: 'mock', statusCode: 200, body: 'always', responseHeaders: {} } });
  for (let i = 0; i < 5; i++) expect(await pageFetch(tab, '/api/prob')).toMatchObject({ status: 200, body: 'always' });
  await window.click('#consoleTabRules');
  await expect(window.locator('.rule-row', { hasText: '*/api/prob*' }).first().locator('.rule-prob')).toHaveText('0%');
  await window.keyboard.press('Control+w');
});

test('a Rewrite rule changes the headers and body the server receives', async () => {
  const { tab } = await openApiTab();
  await matchAndPick('*/echo/headers*', 'rewrite');
  await window.click('#ruleNextBtn');
  await expect(window.locator('#ruleAddBtn')).toBeDisabled(); // a rewrite that changes nothing is not a rule
  await window.click('#ruleRwAddHeader');
  await window.locator('#ruleRwHeaders .kv-key').first().fill('X-Rewritten');
  await window.locator('#ruleRwHeaders .kv-val').first().fill('yes');
  await window.click('#ruleRwAddHeader');
  await window.locator('#ruleRwHeaders .kv-key').nth(1).fill('X-Remove-Me');
  await expect(window.locator('#ruleAddBtn')).toBeEnabled();
  await expect(window.locator('#ruleSummary')).toContainText('Rewrite: 2 headers');
  await window.click('#ruleAddBtn');
  const row = window.locator('.rule-row', { hasText: '*/echo/headers*' });
  await expect(row.locator('.rule-badge')).toHaveText('Rewrite: 2 headers');

  const out = await tab.evaluate(async () => (await fetch('/echo/headers', { headers: { 'X-Remove-Me': 'page-set', 'X-Keep': 'kept' } })).text());
  const headers = JSON.parse(out);
  expect(headers['x-rewritten']).toBe('yes');
  expect(headers['x-keep']).toBe('kept'); // everything else the page sent is untouched
  expect(headers).not.toHaveProperty('x-remove-me'); // an empty value removes a header the page set
  await expect(row.locator('.rule-hits-badge')).toHaveText('1', { timeout: 3_000 });

  await matchAndPick('*/echo/body', 'rewrite');
  await window.click('#ruleNextBtn');
  await window.check('#ruleRwBodyOn');
  await window.fill('#ruleRwBody', 'hello');
  await window.click('#ruleAddBtn');
  const sized = await pageFetch(tab, '/echo/body', { method: 'POST', body: 'x'.repeat(50) }) as { body: string };
  expect(JSON.parse(sized.body).size).toBe(5);
  await window.keyboard.press('Control+w');
});

test('a Rewrite can send another session\'s cookies, live, plus extras — and keeps the last ones after that session closes', async () => {
  const source = await openApiTab();
  await source.tab.evaluate(() => { document.cookie = 'sid=admin-1; path=/'; document.cookie = 'theme=dark; path=/'; });
  const target = await openApiTab();

  await matchAndPick('*/echo/headers*', 'rewrite');
  await window.click('#ruleNextBtn');
  await window.check('#ruleCookiesOn');
  await window.selectOption('#ruleCookieSource', source.partition);
  await window.click('#ruleCookieAddExtra');
  await window.locator('#ruleCookieExtra .kv-key').first().fill('flag');
  await window.locator('#ruleCookieExtra .kv-val').first().fill('on');
  await window.click('#ruleAddBtn');
  await expect(window.locator('.rule-row', { hasText: '*/echo/headers*' }).locator('.rule-badge')).toContainText('cookies from');

  // Order is not meaningful (the browser's jar returns cookies by age), so compare as a set.
  const cookieHeader = async () => (JSON.parse(((await pageFetch(target.tab, '/echo/headers')) as { body: string }).body).cookie as string).split('; ').sort();
  await target.tab.evaluate(() => { document.cookie = 'own=tester; path=/'; }); // the tab's own cookie is replaced, not added to
  expect(await cookieHeader()).toEqual(['flag=on', 'sid=admin-1', 'theme=dark']);

  // Live: the source session changes a cookie, the next request sees it.
  await source.tab.evaluate(() => { document.cookie = 'sid=admin-2; path=/'; });
  expect(await cookieHeader()).toEqual(['flag=on', 'sid=admin-2', 'theme=dark']);

  // Close the source session; the rule carries on with its last cookies.
  await window.click(`.tab[data-id="${source.id}"]`);
  await window.keyboard.press('Control+w');
  await expect(window.locator(`.tab[data-id="${source.id}"]`)).toHaveCount(0);
  await window.click(`.tab[data-id="${target.id}"]`);
  expect(await cookieHeader()).toEqual(['flag=on', 'sid=admin-2', 'theme=dark']);
  await window.click('#consoleTabRules');
  await expect(window.locator('.rule-row', { hasText: '*/echo/headers*' }).locator('.rule-closed-badge')).toContainText('source closed');
  await window.keyboard.press('Control+w');
});

test('altered requests carry one Altered badge, the pill filters to them, and a rewrite shows what was sent', async () => {
  const { tab } = await openApiTab();
  await addMockViaUi('*/api/altered', 200, 'x');
  await matchAndPick('*/echo/headers*', 'rewrite');
  await window.click('#ruleNextBtn');
  await window.click('#ruleRwAddHeader');
  await window.locator('#ruleRwHeaders .kv-key').first().fill('X-Rewritten');
  await window.locator('#ruleRwHeaders .kv-val').first().fill('yes');
  await window.click('#ruleAddBtn');

  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await pageFetch(tab, '/api/altered');
  await pageFetch(tab, '/echo/headers');
  await pageFetch(tab, '/network/status/200');

  const altered = window.locator('.evt.network-request', { has: window.locator('.evt-badge-altered') });
  await expect(altered).toHaveCount(2, { timeout: 10_000 });
  await expect(window.locator('.filter-pill[data-type="altered"] .pill-count')).toHaveText('2');
  await window.click('.filter-pill[data-type="altered"]');
  await expect(window.locator('.evt.network-request', { hasText: '/network/status/200' })).toHaveCount(0);

  await window.locator('.evt.network-request', { hasText: '/echo/headers' }).first().click();
  await expect(window.locator('#detailSent')).toContainText('Sent to the server');
  await expect(window.locator('#detailPanel')).toContainText('X-Rewritten');
  await window.click('.filter-pill[data-type="altered"]'); // leave the filter off for later tests
  await window.keyboard.press('Control+w');
});

test('a rule with a quote/HTML-bearing pattern and body renders safely and round-trips unchanged', async () => {
  const { id } = await openApiTab();
  const pattern = '*/api/"><img src=x onerror=alert(1)>*';
  const body = '<script>window.__pwned = 1</script>"\'';
  await addRuleViaIpc(id, { id: 'xss', urlPattern: pattern, method: '*', probability: 1, enabled: true,
    action: { kind: 'mock', statusCode: 200, body, responseHeaders: {} } });
  await window.click('#consoleTabRules');
  const row = window.locator('.rule-row', { hasText: 'onerror' });
  await expect(row).toBeVisible();
  await expect(row.locator('.rule-url')).toHaveText(pattern);
  expect(await window.locator('#rulesPanel img, #rulesPanel script').count()).toBe(0);
  const stored = await window.evaluate((sid) => (window as any).testerBrowser.rules.getRules(sid), id);
  expect(stored[0].urlPattern).toBe(pattern);
  expect(stored[0].action.body).toBe(body);
  await window.keyboard.press('Control+w');
});

test('exporting then importing rules round-trips every action, without ids, hit stats or a cookie source', async () => {
  const { id, partition } = await openApiTab();
  await addRuleViaIpc(id, { id: 'e1', urlPattern: '*/api/export-m', method: 'GET', probability: 0.5, delayMs: 100, enabled: true,
    action: { kind: 'mock', statusCode: 200, body: 'm', responseHeaders: { a: 'b' }, cors: true } });
  await addRuleViaIpc(id, { id: 'e2', urlPattern: '*/api/export-r', method: '*', probability: 1, enabled: false,
    action: { kind: 'rewrite', headers: { h: 'v' }, body: 'b', cookies: { sourcePartition: partition, extra: { k: 'v' } } } });
  await addRuleViaIpc(id, { id: 'e3', urlPattern: '*/api/export-race', method: '*', probability: 1, enabled: true,
    action: { kind: 'race', batchSize: 3, giveUpAfterMs: 20000 } });
  await window.click('#consoleTabRules');
  await expect(window.locator('.rule-row')).toHaveCount(3);

  const tmpPath = path.join(os.tmpdir(), `testerbrowser-e2e-rules-${Date.now()}.json`);
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath }); }, tmpPath);
  await window.click('.rule-export-btn');
  await expect.poll(() => fs.existsSync(tmpPath), { timeout: 5_000 }).toBe(true);

  const exported = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
  expect(exported.testerBrowserRules).toBe(1);
  expect(exported.rules).toHaveLength(3);
  for (const r of exported.rules) { expect(r.id).toBeUndefined(); expect(r.hitCount).toBeUndefined(); }
  expect(JSON.stringify(exported)).not.toContain(partition);
  expect(exported.rules[1].action.cookies).toEqual({ extra: { k: 'v' } });

  for (const _ of [1, 2, 3]) await window.locator('.rule-row').first().locator('.rule-del-btn').click();
  await expect(window.locator('.rule-row')).toHaveCount(0);
  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [filePath] }); }, tmpPath);
  await window.click('.rule-import-btn');
  await expect(window.locator('#ruleIoStatus')).toHaveText('Imported 3 rules');
  expect(await rowOrder()).toEqual(['*/api/export-m', '*/api/export-r', '*/api/export-race']);
  await expect(window.locator('.rule-row').nth(1)).toHaveClass(/rule-row-disabled/);
  fs.rmSync(tmpPath, { force: true });
  await window.keyboard.press('Control+w');
});

test('importing rejects a file that is not a rules file, and skips an invalid rule while keeping the valid one', async () => {
  await openApiTab();
  await window.click('#consoleTabRules');
  const tmp = (name: string, content: unknown) => {
    const p = path.join(os.tmpdir(), `testerbrowser-e2e-${name}-${Date.now()}.json`);
    fs.writeFileSync(p, JSON.stringify(content));
    return p;
  };
  const importFrom = async (filePath: string) => {
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] }); }, filePath);
    await window.click('.rule-import-btn');
  };

  const oldFormat = tmp('mocks', { testerBrowserMocks: 1, rules: [] });
  await importFrom(oldFormat);
  await expect(window.locator('#ruleIoStatus')).toHaveText('Not a TesterBrowser rules file');
  await expect(window.locator('.rule-row')).toHaveCount(0);

  const mixed = tmp('mixed', { testerBrowserRules: 1, rules: [
    { method: 'GET', urlPattern: '*/api/valid', action: { kind: 'mock', statusCode: 200, body: 'ok' } },
    { method: 'GET', urlPattern: '*/api/invalid', action: { kind: 'mock', statusCode: 99, body: '' } },
  ] });
  await importFrom(mixed);
  await expect(window.locator('#ruleIoStatus')).toHaveText('Imported 1 rules (1 skipped: statusCode must be an integer 100-599)');
  expect(await rowOrder()).toEqual(['*/api/valid']);
  fs.rmSync(oldFormat, { force: true }); fs.rmSync(mixed, { force: true });
  await window.keyboard.press('Control+w');
});

test.describe('Rules persist across a full app restart', () => {
  test('every action kind survives quit and relaunch in the default (persistent) tab, and still intercepts', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-e2e-rules-persist-'));
    let restartApp: ElectronApplication | undefined;
    try {
      restartApp = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
      const win = await getMainWindow(restartApp);
      await win.waitForLoadState('domcontentloaded');
      const sessionId = await win.locator('.tab.active').getAttribute('data-id');
      const add = (r: Record<string, unknown>) =>
        win.evaluate(({ id, rule }) => (window as any).testerBrowser.rules.addRule(id, rule), { id: sessionId, rule: r });
      await add({ id: 'p1', urlPattern: '*/api/restart-mock', method: '*', probability: 1, enabled: true,
        action: { kind: 'mock', statusCode: 200, body: '{"restarted":true}', responseHeaders: {} } });
      await add({ id: 'p2', urlPattern: '*/api/restart-fail', method: '*', probability: 1, enabled: true,
        action: { kind: 'fail', mode: 'missing' } });
      await add({ id: 'p3', urlPattern: '*/api/restart-rw', method: '*', probability: 0.5, delayMs: 10, enabled: true,
        action: { kind: 'rewrite', headers: { 'x-a': '1' }, cookies: { extra: { k: 'v' } } } });

      await restartApp.close(); // triggers before-quit -> saveSessions()
      restartApp = undefined;

      restartApp = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
      const relaunched = await getMainWindow(restartApp);
      await relaunched.waitForLoadState('domcontentloaded');
      await relaunched.click('#consoleTabRules');
      await expect.poll(() => relaunched.locator('.rule-row .rule-url').allTextContents(), { timeout: 10_000 })
        .toEqual(['*/api/restart-mock', '*/api/restart-fail', '*/api/restart-rw']);
      await expect(relaunched.locator('.rule-row').nth(2).locator('.rule-prob')).toHaveText('50%');

      await relaunched.click('#urlbar');
      await relaunched.fill('#urlbar', fixtures.url('/network/api.html'));
      await relaunched.press('#urlbar', 'Enter');
      const apiTab = await getTabPage(restartApp, '/network/api.html');
      expect(await pageFetch(apiTab, '/api/restart-mock')).toMatchObject({ status: 200, body: '{"restarted":true}' });
      expect(await pageFetch(apiTab, '/api/restart-fail')).toMatchObject({ status: 404 });
    } finally {
      if (restartApp) await restartApp.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

test('the Rules primary button and the empty-state call to action use the shared accent fill', async () => {
  await openApiTab();
  await window.click('#consoleTabRules');
  const bg = (sel: string) => window.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor);
  const accent = await bg('#ruleNewBtn');
  expect(accent).not.toBe('rgba(0, 0, 0, 0)');
  await expect(window.locator('#ruleEmpty .empty-state-btn')).toBeVisible();
  expect(await bg('#ruleEmpty .empty-state-btn')).toBe(accent);
  await window.click('#ruleNewBtn');
  await expect(window.locator('#ruleForm')).toHaveClass(/tb-form-card/);
  await window.click('#ruleCancelBtn');
  await window.keyboard.press('Control+w');
});
