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

  // Regression test for #126: upsertFill (the leader-side recording script)
  // mutates the same buffered 'fill' step in place as each keystroke lands,
  // rather than creating a new step per character. The relay used to track
  // "already relayed" purely by step id, so it mirrored only the very first
  // keystroke and then ignored every further mutation of that same step —
  // real character-by-character typing (as opposed to the single scripted
  // `input` event above) is what exposes it.
  const leaderInput = leaderTab.locator('[data-testid="rp-input"]');
  await leaderInput.fill('');
  await leaderInput.pressSequentially('Grace', { delay: 50 });
  await expect(followerTab.locator('[data-testid="rp-input"]')).toHaveValue('Grace', { timeout: 20_000 });

  // "Clear log" empties the mirrored-action log, and mirroring keeps working afterward.
  await expect(window.locator('#followLog .follow-log-line').first()).toBeVisible();
  await window.click('#followClearLogBtn');
  await expect(window.locator('#followLog .follow-log-line')).toHaveCount(0);

  await leaderTab.evaluate(() => (document.querySelector('[data-testid="rp-btn"]') as HTMLElement).click());
  await expect(window.locator('#followLog')).toContainText('mirrored', { timeout: 20_000 });
});

test('mirrored navigation logs the destination URL, and stops logging once disabled (#186)', async () => {
  const leaderStart = '/record/target.html';
  const followerStart = '/storage/cookies.html';
  const mirrorDest = '/accessibility/index.html';
  const afterDisableDest = '/downloads/index.html';

  // Switching sessions through testerBrowser.sessions.switchTo() directly (bypassing
  // the tab UI) leaves the renderer's own "active session" bookkeeping stale, so the
  // urlbar keeps submitting to whichever session was last activated via a real click.
  // Click the tab itself, as a user would, to switch reliably.
  const switchToTab = (id: string) => window.click(`.tab[data-id="${id}"] .tab-name`);

  // A full-page navigation replaces a session's CDP target, so a Playwright Page
  // reference captured before such a navigation goes stale and never reflects the
  // new URL — poll the app's own session list (kept in sync on every navigation)
  // instead of holding onto a Page across a leader/follower navigation.
  const sessionUrl = (id: string) => window.evaluate(
    (sid: string) => (window as any).testerBrowser.sessions.list().then(
      (list: { id: string; url: string }[]) => list.find((s) => s.id === sid)?.url
    ), id
  );
  const expectSessionUrl = (id: string, path: string) => expect.poll(() => sessionUrl(id), { timeout: 20_000 })
    .toContain(path);

  const idsBefore = new Set(
    (await window.evaluate(() => (window as any).testerBrowser.sessions.list())).map((s: { id: string }) => s.id)
  );

  await window.click('#newSessionBtn');
  let sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const leaderId = sessions.map((s: { id: string }) => s.id).find((id: string) => !idsBefore.has(id));
  idsBefore.add(leaderId);

  await switchToTab(leaderId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(leaderStart));
  await window.press('#urlbar', 'Enter');
  await expectSessionUrl(leaderId, leaderStart);

  await window.click('#newSessionBtn');
  sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const followerId = sessions.map((s: { id: string }) => s.id).find((id: string) => !idsBefore.has(id));

  await switchToTab(followerId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(followerStart));
  await window.press('#urlbar', 'Enter');
  await expectSessionUrl(followerId, followerStart);

  await window.click('#consoleTabFollow');
  await window.selectOption('#followPickLeader', leaderId);
  await window.selectOption('#followPickFollower', followerId);
  await window.check('#followMirrorNav');
  await window.click('#followStartBtn');
  const pairRow = window.locator(`.follow-pair[data-leader="${leaderId}"]`);
  await expect(pairRow).toBeVisible();
  await expect(pairRow.locator('.follow-nav-check')).toBeChecked();

  await window.click('#followClearLogBtn');
  await expect(window.locator('#followLog .follow-log-line')).toHaveCount(0);

  await switchToTab(leaderId);
  // Switching tabs updates the urlbar asynchronously; wait for it to reflect
  // the leader's own current page before typing into it, otherwise the
  // navigation below can race and land on whichever session was active before.
  await expect(window.locator('#urlbar')).toHaveValue(fixtures.url(leaderStart), { timeout: 5_000 });
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(mirrorDest));
  await window.press('#urlbar', 'Enter');

  await expectSessionUrl(leaderId, mirrorDest);
  await expectSessionUrl(followerId, mirrorDest);

  const logLine = window.locator('#followLog .follow-log-line').first();
  await expect(logLine).toBeVisible();
  await expect(logLine).toHaveClass(/ok/);
  await expect(logLine).toContainText(fixtures.url(mirrorDest));

  // Disabling mirror navigation for the pair stops further mirroring, and
  // stops the log from growing for navigation steps.
  await pairRow.locator('.follow-nav-check').uncheck();
  const countBefore = await window.locator('#followLog .follow-log-line').count();

  await switchToTab(leaderId);
  await expect(window.locator('#urlbar')).toHaveValue(fixtures.url(mirrorDest), { timeout: 5_000 });
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(afterDisableDest));
  await window.press('#urlbar', 'Enter');
  await expectSessionUrl(leaderId, afterDisableDest);

  // Give the (now-disabled) mirror a moment to fire if it incorrectly still would.
  await window.waitForTimeout(1000);
  await expect(window.locator('#followLog .follow-log-line')).toHaveCount(countBefore);
  await expect(await sessionUrl(followerId)).toContain(mirrorDest);
});
