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

  // #242: a checkbox interaction relays as a real checked-state change
  // ('check' step type, dispatched the same way the fill/click cases
  // above are), not a meaningless "on" string typed into a text field.
  await leaderTab.evaluate(() => {
    const el = document.querySelector('[data-testid="rp-checkbox"]') as HTMLInputElement;
    el.checked = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(followerTab.locator('[data-testid="rp-checkbox"]')).toBeChecked({ timeout: 20_000 });
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
  idsBefore.add(followerId);

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

  // #253: set up a SECOND, still-enabled leader/follower pair now, before
  // triggering the first pair's post-disable navigation below. Starting a
  // pair (followStartBtn -> startFollow()) clears #followLog as a side
  // effect (see followalong.js), so countBefore must be captured *after*
  // this pair exists, not before — otherwise the log-clear itself would
  // wipe out the very evidence being protected.
  await window.click('#newSessionBtn');
  sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const leader2Id = sessions.map((s: { id: string }) => s.id).find((id: string) => !idsBefore.has(id));
  idsBefore.add(leader2Id);

  await switchToTab(leader2Id);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(leaderStart));
  await window.press('#urlbar', 'Enter');
  await expectSessionUrl(leader2Id, leaderStart);

  await window.click('#newSessionBtn');
  sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const follower2Id = sessions.map((s: { id: string }) => s.id).find((id: string) => !idsBefore.has(id));
  idsBefore.add(follower2Id);

  await switchToTab(follower2Id);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(followerStart));
  await window.press('#urlbar', 'Enter');
  await expectSessionUrl(follower2Id, followerStart);

  await window.click('#consoleTabFollow');
  await window.selectOption('#followPickLeader', leader2Id);
  await window.selectOption('#followPickFollower', follower2Id);
  await window.check('#followMirrorNav');
  await window.click('#followStartBtn');
  await expect(window.locator(`.follow-pair[data-leader="${leader2Id}"]`)).toBeVisible();

  const countBefore = await window.locator('#followLog .follow-log-line').count();

  await switchToTab(leaderId);
  await expect(window.locator('#urlbar')).toHaveValue(fixtures.url(mirrorDest), { timeout: 5_000 });
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(afterDisableDest));
  await window.press('#urlbar', 'Enter');
  await expectSessionUrl(leaderId, afterDisableDest);

  // Rather than sleeping a fixed window and hoping it was long enough for
  // the (now-disabled) mirror to have fired if it incorrectly still would,
  // navigate the second, still-enabled pair and wait for ITS OWN new
  // follow-log-line. Both navigations are dispatched before either wait, so
  // the relay (which processes queued events in order on its own poll loop)
  // has had a full cycle to mirror the first pair's navigation too, if it
  // were going to. Asserting the count grew by exactly 1 (the second pair's
  // own line) rather than 2 is the proof the first pair stayed silent.
  await switchToTab(leader2Id);
  await expect(window.locator('#urlbar')).toHaveValue(fixtures.url(leaderStart), { timeout: 5_000 });
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(mirrorDest));
  await window.press('#urlbar', 'Enter');
  await expectSessionUrl(leader2Id, mirrorDest);
  await expectSessionUrl(follower2Id, mirrorDest);

  await expect(window.locator('#followLog .follow-log-line')).toHaveCount(countBefore + 1);
  await expect(await sessionUrl(followerId)).toContain(mirrorDest);
});

// ── Disambiguating session pickers, and a shared-partition warning (#258) ──

test('session picker options are labelled with the session name and current host, so two tabs on the same site are distinguishable', async () => {
  const sharedPath = '/record/target.html';

  const idsBefore = new Set(
    (await window.evaluate(() => (window as any).testerBrowser.sessions.list())).map((s: { id: string }) => s.id)
  );

  await window.click('#newSessionBtn');
  let sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const idA = sessions.map((s: { id: string }) => s.id).find((id: string) => !idsBefore.has(id));
  idsBefore.add(idA);

  // pickerLabel() reads each session's `url` from sessions.list(), which the
  // main process only populates once its own did-navigate handler updates
  // currentUrl — a separate event from the tab's own page 'load' event that
  // waitForLoadState('load') below observes, and not guaranteed to have
  // landed yet the instant it fires on a slower/contended CI runner. Poll
  // sessions.list() itself for the url actually showing up before treating
  // this session as "navigated", rather than relying on the tab page's own
  // load state as a proxy for the main process's bookkeeping being current.
  const waitForSessionUrl = (id: string) => expect.poll(async () => {
    const list = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
    return list.find((s: { id: string }) => s.id === id)?.url;
  }, { timeout: 10_000 }).toContain(sharedPath);

  await window.click(`.tab[data-id="${idA}"] .tab-name`);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(sharedPath));
  await window.press('#urlbar', 'Enter');
  const tabA = await getTabPage(app, sharedPath);
  await tabA.waitForLoadState('load');
  await waitForSessionUrl(idA);

  await window.click('#newSessionBtn');
  sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const idB = sessions.map((s: { id: string }) => s.id).find((id: string) => !idsBefore.has(id));
  idsBefore.add(idB);

  await window.click(`.tab[data-id="${idB}"] .tab-name`);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(sharedPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, sharedPath, tabA)).waitForLoadState('load');
  await waitForSessionUrl(idB);

  await window.click('#consoleTabFollow');
  const host = new URL(fixtures.url(sharedPath)).host;
  const textA = await window.locator(`#followPickLeader option[value="${idA}"]`).textContent();
  const textB = await window.locator(`#followPickLeader option[value="${idB}"]`).textContent();

  expect(textA).toContain(`— ${host}`);
  expect(textB).toContain(`— ${host}`);
  // Both tabs are on the exact same URL — the tab name is what keeps the two
  // option texts apart, proving the label isn't just "always show the host"
  // with the name lost in the process.
  expect(textA).not.toBe(textB);
});

test('starting Follow Along on a shared-partition pair shows a warning in the log', async () => {
  const idsBefore = new Set(
    (await window.evaluate(() => (window as any).testerBrowser.sessions.list())).map((s: { id: string }) => s.id)
  );

  await window.click('#newSessionBtn');
  const sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const leaderId = sessions.map((s: { id: string }) => s.id).find((id: string) => !idsBefore.has(id));
  idsBefore.add(leaderId);

  // "New tab in this session" — the '+' immediately after a solo tab's own
  // run (renderer/tabs.js) creates a new tab sharing that tab's partition,
  // i.e. its cookies and storage.
  await window.locator(`.tab[data-id="${leaderId}"] + .tab-group-add`).click();
  await expect.poll(
    () => window.evaluate(() => (window as any).testerBrowser.sessions.list().then((l: unknown[]) => l.length))
  ).toBe(sessions.length + 1);
  const afterCreate = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const followerId = afterCreate.map((s: { id: string }) => s.id).find((id: string) => !idsBefore.has(id));

  await window.click('#consoleTabFollow');
  await window.selectOption('#followPickLeader', leaderId);
  await window.selectOption('#followPickFollower', followerId);
  await window.click('#followStartBtn');

  const warningLine = window.locator('#followLog .follow-log-line.warn');
  await expect(warningLine).toBeVisible();
  await expect(warningLine).toContainText('Leader and follower share cookies/storage — actions will affect the same account.');

  await window.locator(`.follow-pair[data-leader="${leaderId}"] .follow-stop-btn`).click();
});
