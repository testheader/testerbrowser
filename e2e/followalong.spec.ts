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

test('Follow Along tab button is present', async () => {
  await expect(window.locator('#consoleTabFollow')).toBeVisible();
});

test('clicking Follow Along tab shows followPanel', async () => {
  await window.click('#consoleTabFollow');
  await expect(window.locator('#followPanel')).toBeVisible();
});

test('leader interactions are mirrored onto the follower in near real time', async () => {
  const urlPath = '/record/target.html';

  // Session A (the default, already-open session) is the leader.
  const sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const leaderId = sessions[0].id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), leaderId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const leaderTab = await getTabPage(app, urlPath);

  // Create and navigate the follower to the same fixture, so leader/follower
  // selectors resolve against matching DOM.
  await window.click('#newSessionBtn');
  const allSessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const followerId = allSessions.find((s: { id: string }) => s.id !== leaderId).id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), followerId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const followerTab = await getTabPage(app, urlPath, leaderTab);

  await window.click('#consoleTabFollow');
  await window.selectOption('#followPickLeader', leaderId);
  await window.selectOption('#followPickFollower', followerId);
  await window.click('#followStartBtn');
  await expect(window.locator('.follow-pair')).toBeVisible();

  // Dispatched via the page's own JS rather than Playwright-driven CDP input
  // events: this session also carries the app's own always-on CDP debugger
  // (recording, plus Follow Along's own harvest/relay polling), and a second,
  // independently-driven CDP session issuing input on top of that has proven
  // unreliable under load — a real 'input'/'click' DOM event exercises the
  // exact same recording path the RECORDING_SCRIPT listens for either way.
  await leaderTab.evaluate(() => {
    const el = document.querySelector('[data-testid="rp-input"]') as HTMLInputElement;
    el.focus();
    el.value = 'Ada';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Wait for the fill to mirror before firing the next step — the relay polls
  // every 300ms and plays back one step at a time, so overlapping actions
  // here just races the app's own relay loop for no test benefit.
  await expect(followerTab.locator('[data-testid="rp-input"]')).toHaveValue('Ada', { timeout: 20_000 });

  await leaderTab.evaluate(() => (document.querySelector('[data-testid="rp-btn"]') as HTMLElement).click());
  await expect(followerTab.locator('#rp-result')).toHaveText('Clicked: Ada', { timeout: 20_000 });
  await expect(window.locator('#followLog')).toContainText('mirrored', { timeout: 5_000 });
});
