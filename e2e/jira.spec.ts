import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
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
  // safeStorage.isEncryptionAvailable() is false on a headless Linux CI/
  // sandbox runner with no keyring daemon (gnome-keyring/kwallet) reachable
  // — setUsePlainTextEncryption(true) is Electron's own documented escape
  // hatch for exactly this ("force the module to use an in memory password
  // ... when a valid OS password manager cannot be determined"), and is a
  // no-op on Windows/macOS, which is what real CI (windows-2022 runners) and
  // real users' DPAPI/Keychain already use regardless of this call.
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true));
  await window.click('#consoleTabJira');
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

async function getJiraSettings() {
  return window.evaluate(() => (window as unknown as {
    testerBrowser: { jira: { getSettings(): Promise<Record<string, unknown>> } };
  }).testerBrowser.jira.getSettings());
}

// #267: saving a token must never leave plaintext on disk, and getSettings()
// must never hand the token (or its ciphertext) back to the renderer.
test('saving settings with a token encrypts it at rest and never returns it to the renderer', async () => {
  await window.click('#jiraSettingsBtn');
  await window.fill('#jiraBaseUrl', fixtures.url());
  await window.fill('#jiraEmail', 'tester@example.com');
  await window.fill('#jiraApiToken', 'super-secret-token');
  await window.fill('#jiraProjectKey', 'test');
  await window.fill('#jiraIssueType', 'Bug');
  await window.click('#jiraSaveSettingsBtn');
  await expect(window.locator('#jiraSettingsMsg')).toContainText('Saved.', { timeout: 5_000 });

  const settings = await getJiraSettings();
  expect(settings.hasToken).toBe(true);
  expect(settings).not.toHaveProperty('apiToken');
  expect(settings).not.toHaveProperty('apiTokenEnc');
  expect(settings.projectKey).toBe('TEST');

  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const raw = fs.readFileSync(path.join(userDataDir, 'jira-settings.json'), 'utf-8');
  expect(raw).not.toContain('super-secret-token');
  expect(raw).not.toContain('"apiToken"');
  expect(raw).toContain('"apiTokenEnc"');

  // Reopening settings shows "Token saved" instead of a (necessarily empty,
  // since the token is never sent back) password field.
  await window.click('#jiraSettingsBtn');
  await expect(window.locator('#jiraTokenSaved')).toBeVisible();
  await expect(window.locator('#jiraApiToken')).toBeHidden();
  await window.click('#jiraCancelSettingsBtn');
});

// #267: safe error parsing — an HTML error page (SSO redirect/proxy/502)
// must surface the HTTP status, not throw a JSON parse error.
test('fetching a ticket that 502s shows the HTTP status instead of a JSON parse error', async () => {
  await window.fill('#jiraTicketKey', 'BAD-1');
  await window.click('#jiraFetchBtn');
  await expect(window.locator('#jiraTicketDisplay')).toContainText('HTTP 502', { timeout: 5_000 });
});

// #267: loading a real ticket then creating a bug links the new issue to it,
// uses the configured issue type, and renders the created key as a link
// rather than plain text.
test('creating a bug while a ticket is loaded links to it and shows a clickable key', async () => {
  await window.fill('#jiraTicketKey', 'TEST-1');
  await window.click('#jiraFetchBtn');
  await expect(window.locator('.jira-ticket-key')).toHaveText('TEST-1', { timeout: 5_000 });

  await window.click('#jiraAddBugBtn');
  await window.fill('#jiraBugSummary', 'A real bug');
  await window.click('#jiraSubmitBugBtn');

  const createdLink = window.locator('#jiraCreatedLink');
  await expect(createdLink).toHaveText('TEST-2', { timeout: 5_000 });
  await expect(window.locator('#jiraBugMsg')).not.toContainText('could not link');

  // Fetched from the test process, not the chrome window — the chrome
  // window's own CSP (connect-src 'none') blocks fetch() from its
  // privileged renderer context.
  const issueLinks = await (await fetch(fixtures.url('/rest/api/3/__debug/issueLinks'))).json();
  expect(issueLinks).toHaveLength(1);
  const link = issueLinks[0] as { type: { name: string }; inwardIssue: { key: string }; outwardIssue: { key: string } };
  expect(link.type.name).toBe('Relates');
  expect(link.inwardIssue.key).toBe('TEST-2');
  expect(link.outwardIssue.key).toBe('TEST-1');

  // Clicking the key opens the browse URL externally, not in-app. Stub the
  // app:openExternal handler itself, the same way update-pill.spec.ts stubs
  // app:restartAndInstall — the real handler only allows https:// URLs, and
  // the fixture server is plain http://.
  await app.evaluate(({ ipcMain }) => {
    (globalThis as unknown as { __openExternalCalls: string[] }).__openExternalCalls = [];
    ipcMain.removeHandler('app:openExternal');
    ipcMain.handle('app:openExternal', (_e, url: string) => {
      (globalThis as unknown as { __openExternalCalls: string[] }).__openExternalCalls.push(url);
    });
  });
  await createdLink.click();
  await expect.poll(async () =>
    app.evaluate(() => (globalThis as unknown as { __openExternalCalls: string[] }).__openExternalCalls)
  ).toEqual([fixtures.url('/browse/TEST-2')]);
});

interface RecordedAttachment {
  filename: string; size: number; contentType: string; hadAtlassianToken: boolean; dataBase64: string;
}

async function getRecordedAttachments(): Promise<RecordedAttachment[]> {
  return (await fetch(fixtures.url('/rest/api/3/__debug/attachments'))).json();
}

// #245: real evidence, actually uploaded — not just that the app claims to
// have attached something. Steps stays disabled since nothing was recorded
// on this tab; screenshot/HAR/console-errors are on by default and get
// genuinely uploaded, each with the required X-Atlassian-Token header.
test('creating a bug with the evidence checkboxes checked attaches screenshot, HAR and console errors; Steps stays disabled with nothing recorded (#245)', async () => {
  // Every earlier bug-report submission in this file also uploaded the
  // (default-on) screenshot/HAR/console-errors evidence as a side effect,
  // without ever reading this debug endpoint — drain that backlog first so
  // this test only sees what its own submission below actually uploads.
  await getRecordedAttachments();

  const urlPath = '/console/logs.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');
  // logs.html emits console.error('error on load') plus a missing-image
  // Log.entryAdded (level error) on load — captured by the always-on
  // recorder regardless of whether the console panel is even open. Poll the
  // recorder's own timeline (not the page) until that console event has
  // actually landed, since the bug-report evidence below reads straight
  // from the recorder buffer.
  const activeId = await window.evaluate(() => document.querySelector('.tab.active')?.getAttribute('data-id'));
  await expect.poll(async () => {
    const events = await window.evaluate(
      (id: string) => (window as any).testerBrowser.recording.timeline(id, { limit: 5000 }),
      activeId
    );
    return events.some((e: { kind: string; summary: string }) => e.kind === 'console' && e.summary.includes('error on load'));
  }, { timeout: 10_000 }).toBe(true);

  await window.click('#consoleTabJira');
  await window.click('#jiraAddBugBtn');

  const stepsCheckbox = window.locator('#jiraAttachSteps');
  await expect(stepsCheckbox).toBeDisabled();
  await expect(stepsCheckbox).not.toBeChecked();
  await expect(stepsCheckbox).toHaveAttribute('title', /no recorded steps/i);

  await expect(window.locator('#jiraAttachScreenshot')).toBeChecked();
  await expect(window.locator('#jiraAttachHar')).toBeChecked();
  await expect(window.locator('#jiraAttachConsole')).toBeChecked();

  await window.fill('#jiraBugSummary', 'Evidence bug');
  await window.click('#jiraSubmitBugBtn');

  await expect(window.locator('#jiraBugMsg')).toContainText('attached 3/3', { timeout: 10_000 });

  const attachments = await getRecordedAttachments();
  expect(attachments.map((a) => a.filename).sort()).toEqual(['console-errors.txt', 'network.har', 'screenshot.png']);
  for (const a of attachments) {
    expect(a.hadAtlassianToken).toBe(true);
    expect(a.size).toBeGreaterThan(0);
  }

  const har = JSON.parse(
    Buffer.from(attachments.find((a) => a.filename === 'network.har')!.dataBase64, 'base64').toString('utf-8')
  );
  expect(har.log.version).toBe('1.2');

  const consoleErrorsText = Buffer.from(
    attachments.find((a) => a.filename === 'console-errors.txt')!.dataBase64, 'base64'
  ).toString('utf-8');
  expect(consoleErrorsText).toContain('error on load');
});

// #245: a rejected attachment (413) never loses the already-created issue,
// and the failure names the specific file — not a generic error.
test('a rejected attachment is reported as a partial failure, naming the file, without losing the created issue (#245)', async () => {
  await fetch(fixtures.url('/rest/api/3/__debug/attachmentStatus'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'network.har', status: 413 }),
  });

  await window.click('#consoleTabJira');
  await window.click('#jiraAddBugBtn');
  await window.fill('#jiraBugSummary', 'Partial failure bug');
  await window.click('#jiraSubmitBugBtn');

  await expect(window.locator('#jiraBugMsg')).toContainText('attached 2/3', { timeout: 10_000 });
  await expect(window.locator('#jiraBugMsg')).toContainText('network.har');
  await expect(window.locator('#jiraCreatedLink')).toBeVisible();

  // Reset the override so it doesn't leak into any later run of this file.
  await fetch(fixtures.url('/rest/api/3/__debug/attachmentStatus'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
});
