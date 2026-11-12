import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

// Race gate (Resilience rule type `race`): parks matching requests at the CDP
// Fetch pause until N have arrived, then releases them together. The fixture's
// /race/redeem is a single-use coupon with a check-then-act window, so a gate
// that really does release requests together shows up as >1 success, and a
// gate that really holds them shows up as 0 server hits.

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

type RaceState = { remaining: number; hits: number; successes: number };

async function serverState(): Promise<RaceState> {
  return (await fetch(fixtures.url('/race/state'))).json() as Promise<RaceState>;
}

async function resetServer(): Promise<void> {
  await fetch(fixtures.url('/race/reset'), { method: 'POST' });
}

/** Fresh session on its own partition (rules are per partition), parked on a same-origin page. */
async function openRaceTab(label: string): Promise<Page> {
  await window.click('#newSessionBtn');
  const urlPath = `/network/api.html?t=race-${label}`;
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  return getTabPage(app, urlPath);
}

async function activeSessionId(): Promise<string> {
  return (await window.locator('.tab.active').getAttribute('data-id')) as string;
}

/** Adds a race rule through the real form (type chip, URL step, options step). */
async function addRaceRuleViaUi(url: string, holdCount: number, timeoutSec: number): Promise<void> {
  await window.click('#consoleTabResilience');
  if (!(await window.locator('#resForm').isVisible())) await window.click('#resNewRuleBtn');
  await window.click('.res-type-chip[data-type="race"]');
  await window.click('#resNextBtn');
  await window.fill('#resUrl', url);
  await window.click('#resNextBtn');
  await window.fill('#resHoldCount', String(holdCount));
  await window.fill('#resRelease', String(timeoutSec));
  await window.click('.res-add-btn');
  await expect(window.locator('.res-rule-row', { hasText: url })).toBeVisible();
}

/** Starts `n` POSTs to the coupon endpoint from the page; resolves to their statuses. */
function fireRedeems(tab: Page, n: number): Promise<number[]> {
  return tab.evaluate(
    (count) => Promise.all(Array.from({ length: count }, () =>
      fetch('/race/redeem', { method: 'POST' }).then((r) => r.status))),
    n);
}

test.beforeEach(resetServer);

test('control: requests awaited one at a time redeem the coupon exactly once', async () => {
  const tab = await openRaceTab('control');
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push(...(await fireRedeems(tab, 1)));
  expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  expect(statuses.filter((s) => s === 409)).toHaveLength(2);
  await window.keyboard.press('Control+w');
});

test('the Race gate form shows hold count + timeout, hides probability, and lists the rule', async () => {
  await openRaceTab('form');
  await window.click('#consoleTabResilience');
  if (!(await window.locator('#resForm').isVisible())) await window.click('#resNewRuleBtn');
  await window.click('.res-type-chip[data-type="race"]');
  await window.click('#resNextBtn');
  await window.fill('#resUrl', '*/race/redeem*');
  await window.click('#resNextBtn');

  await expect(window.locator('#resHoldField')).toBeVisible();
  await expect(window.locator('#resReleaseField')).toBeVisible();
  await expect(window.locator('#resReleaseLabel')).toHaveText('Timeout (s)');
  await expect(window.locator('#resProb')).toBeDisabled();
  await expect(window.locator('#resRelease')).toHaveValue('10'); // default timeout, never "forever"

  // Out-of-range hold count blocks the Add button.
  await window.fill('#resHoldCount', '1');
  await expect(window.locator('.res-add-btn')).toBeDisabled();
  await window.fill('#resHoldCount', '51');
  await expect(window.locator('.res-add-btn')).toBeDisabled();
  await window.fill('#resHoldCount', '4');
  await expect(window.locator('.res-add-btn')).toBeEnabled();
  await expect(window.locator('#resSummary')).toContainText('holds 4 requests');

  await window.click('.res-add-btn');
  const row = window.locator('.res-rule-row', { hasText: '*/race/redeem*' });
  await expect(row).toBeVisible();
  await expect(row.locator('.res-rule-delay')).toHaveText('×4 · 10 s');
  await window.keyboard.press('Control+w');
});

test('a gate of 3 releases requests together even when they were sent apart, so the coupon is redeemed more than once', async () => {
  const tab = await openRaceTab('release');
  await addRaceRuleViaUi('*/race/redeem*', 3, 30);

  // Sent 300 ms apart (3x the endpoint's check-then-act window). Ungated, the
  // first would finish before the second is even sent, so exactly one would
  // succeed (see the control test). Only a gate that parks them and releases
  // them together can make more than one win.
  const statuses = await tab.evaluate(async () => {
    const out: Promise<number>[] = [];
    for (let i = 0; i < 3; i++) {
      out.push(fetch('/race/redeem', { method: 'POST' }).then((r) => r.status));
      if (i < 2) await new Promise((r) => setTimeout(r, 300));
    }
    return Promise.all(out);
  });
  expect(statuses).toHaveLength(3); // all released, none stuck
  expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(1); // the race was won
  expect((await serverState()).hits).toBe(3);
  await window.keyboard.press('Control+w');
});

test('requests are held before the network until the gate fills', async () => {
  const tab = await openRaceTab('hold');
  await addRaceRuleViaUi('*/race/redeem*', 3, 30);

  const pending = tab.evaluate(() => {
    (window as unknown as { __race: Promise<number>[] }).__race = [0, 1].map(() =>
      fetch('/race/redeem', { method: 'POST' }).then((r) => r.status));
  });
  await pending;
  await new Promise((r) => setTimeout(r, 750)); // well past the endpoint's own 100 ms window
  expect((await serverState()).hits).toBe(0);   // nothing has reached the server

  // The third request fills the gate and frees all three.
  const all = await tab.evaluate(async () => {
    const held = (window as unknown as { __race: Promise<number>[] }).__race;
    const third = fetch('/race/redeem', { method: 'POST' }).then((r) => r.status);
    return Promise.all([...held, third]);
  });
  expect(all).toHaveLength(3);
  expect((await serverState()).hits).toBe(3);
  await window.keyboard.press('Control+w');
});

test('a gate that never fills releases on its timeout instead of hanging the page', async () => {
  const tab = await openRaceTab('timeout');
  await addRaceRuleViaUi('*/race/redeem*', 5, 1);

  const result = await tab.evaluate(async () => {
    const start = Date.now();
    const status = await fetch('/race/redeem', { method: 'POST' }).then((r) => r.status);
    return { status, ms: Date.now() - start };
  });
  expect(result.status).toBe(200);
  expect(result.ms).toBeGreaterThanOrEqual(900); // it did wait for the timeout…
  expect(result.ms).toBeLessThan(5_000);         // …and not for the (never-reached) count
  await window.keyboard.press('Control+w');
});

test('removing the rule releases requests that are parked at the gate', async () => {
  const tab = await openRaceTab('remove');
  await addRaceRuleViaUi('*/race/redeem*', 5, 60);

  const inFlight = tab.evaluate(() =>
    fetch('/race/redeem', { method: 'POST' }).then((r) => r.status));
  await new Promise((r) => setTimeout(r, 500));
  expect((await serverState()).hits).toBe(0);

  await window.locator('.res-rule-row', { hasText: '*/race/redeem*' }).locator('.res-del-btn').click();
  expect(await inFlight).toBe(200);
  expect((await serverState()).hits).toBe(1);
  await window.keyboard.press('Control+w');
});

test('a disabled race rule no longer gates requests', async () => {
  const tab = await openRaceTab('disable');
  await addRaceRuleViaUi('*/race/redeem*', 5, 60);
  const sessionId = await activeSessionId();
  await window.locator('.res-rule-row', { hasText: '*/race/redeem*' }).locator('.res-enable').uncheck();
  await expect.poll(() => window.evaluate(
    (id) => (window as any).testerBrowser.resilience.getRules(id), sessionId,
  ).then((rules: { enabled: boolean }[]) => rules[0]?.enabled)).toBe(false);

  const started = Date.now();
  expect(await fireRedeems(tab, 1)).toEqual([200]);
  expect(Date.now() - started).toBeLessThan(3_000); // straight through, no 60 s hold
  await window.keyboard.press('Control+w');
});
