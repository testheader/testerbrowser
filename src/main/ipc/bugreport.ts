import { ipcMain, net, safeStorage, shell, app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readLogTail, capLogBlock, capIssueBody, decideScreenshotStrategy } from '../logTail';
import { getRecentErrors } from '../appLogger';
import { isPathInside } from '../pathSafety';
import {
  buildDefaultDiagnosticsText, wrapDiagnosticsMarkdown, buildBugReportTitle,
  findProjectBoardId, projectItemWasAdded,
} from '../bugReportFormat';
import type { JsonStore } from '../jsonFile';
import type { AppDeps } from './deps';

// GitHub token for the in-app bug reporter is encrypted at rest via OS-level
// safeStorage (DPAPI / Keychain / libsecret) — only the ciphertext touches disk.
// refreshTokenEnc is only populated when the GitHub OAuth App has "token
// expiration" enabled, in which case access tokens are short-lived (~8h) and
// must be renewed via the refresh token (itself valid ~6 months) instead of
// forcing the user back through the device-flow sign-in.
export interface BugReportSettings { tokenEnc: string | null; refreshTokenEnc: string | null; refreshExpiresAt: number | null; }

export interface BugReportIpcStores {
  bugReportStore: JsonStore<BugReportSettings>;
}

const GH_REPO_OWNER = 'testheader';
const GH_REPO_NAME = 'testerbrowser';
const OAUTH_CLIENT_ID = 'Ov23licgMtABkVvMJiem';

/** In-app bug reporter (GitHub OAuth device flow, issue creation, diagnostics, crash/app log) IPC. */
export function registerBugreportIpc(deps: AppDeps, stores: BugReportIpcStores): void {
  const { getWin, getSessionManager, getLogsDir, log } = deps;
  const { bugReportStore } = stores;

  let oauthPollAbort: AbortController | null = null;

  function getGithubToken(): string | null {
    const s = bugReportStore.get();
    if (!s.tokenEnc || !safeStorage.isEncryptionAvailable()) return null;
    try { return safeStorage.decryptString(Buffer.from(s.tokenEnc, 'base64')); } catch { return null; }
  }

  function getGithubRefreshToken(): string | null {
    const s = bugReportStore.get();
    if (!s.refreshTokenEnc || !safeStorage.isEncryptionAvailable()) return null;
    try { return safeStorage.decryptString(Buffer.from(s.refreshTokenEnc, 'base64')); } catch { return null; }
  }

  function clearGithubTokens(): void {
    bugReportStore.set({ tokenEnc: null, refreshTokenEnc: null, refreshExpiresAt: null });
  }

  function saveGithubToken(token: string, refreshToken?: string | null, refreshExpiresIn?: number | null): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const current = bugReportStore.get();
    bugReportStore.set({
      tokenEnc: safeStorage.encryptString(token).toString('base64'),
      refreshTokenEnc: refreshToken
        ? safeStorage.encryptString(refreshToken).toString('base64')
        : current.refreshTokenEnc,
      refreshExpiresAt: refreshExpiresIn ? Date.now() + refreshExpiresIn * 1000 : current.refreshExpiresAt,
    });
    return true;
  }

  // Renews the access token via the refresh token instead of forcing the user
  // back through the device-flow sign-in. Returns the new access token, or
  // null if there's no refresh token, it's expired, or GitHub rejects it —
  // in which case stored tokens are cleared so the UI falls back to sign-in.
  async function refreshGithubToken(): Promise<string | null> {
    const refreshToken = getGithubRefreshToken();
    const { refreshExpiresAt } = bugReportStore.get();
    if (!refreshToken || (refreshExpiresAt && Date.now() >= refreshExpiresAt)) {
      clearGithubTokens();
      return null;
    }
    try {
      const res = await net.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'TesterBrowser-BugReporter' },
        body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
      });
      const data = await res.json() as { access_token?: string; refresh_token?: string; refresh_token_expires_in?: number; error?: string };
      if (!data.access_token) {
        clearGithubTokens();
        return null;
      }
      // GitHub rotates the refresh token on every use — persist the new one, falling back to the old.
      saveGithubToken(data.access_token, data.refresh_token ?? refreshToken, data.refresh_token_expires_in ?? null);
      return data.access_token;
    } catch {
      return null;
    }
  }

  async function pollDeviceFlow(deviceCode: string, intervalSecs: number, expiresAt: number, signal: AbortSignal) {
    let pollInterval = intervalSecs;
    while (Date.now() < expiresAt && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollInterval * 1000);
        signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
      if (signal.aborted) return;
      try {
        const res = await net.fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'TesterBrowser-BugReporter' },
          body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
        });
        const data = await res.json() as {
          access_token?: string; error?: string; interval?: number;
          refresh_token?: string; refresh_token_expires_in?: number;
        };
        if (data.access_token) {
          saveGithubToken(data.access_token, data.refresh_token ?? null, data.refresh_token_expires_in ?? null);
          getWin()?.webContents.send('bugreport:oauthDone', { ok: true });
          return;
        }
        if (data.error === 'slow_down') pollInterval = (data.interval ?? pollInterval) + 5;
        else if (data.error === 'access_denied' || data.error === 'expired_token') {
          getWin()?.webContents.send('bugreport:oauthDone', { ok: false, error: data.error });
          return;
        }
        // 'authorization_pending' → keep polling
      } catch { /* network hiccup — keep polling */ }
    }
    if (!signal.aborted) getWin()?.webContents.send('bugreport:oauthDone', { ok: false, error: 'expired_token' });
  }

  ipcMain.handle('bugreport:startOAuth', async () => {
    oauthPollAbort?.abort();
    oauthPollAbort = new AbortController();
    try {
      const res = await net.fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'TesterBrowser-BugReporter' },
        body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, scope: 'public_repo' }),
      });
      if (!res.ok) return { ok: false, error: `GitHub returned HTTP ${res.status}` };
      const data = await res.json() as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number };
      if (!data.device_code || !data.user_code) return { ok: false, error: 'Invalid response from GitHub' };
      shell.openExternal(data.verification_uri ?? 'https://github.com/login/device');
      const expiresAt = Date.now() + (data.expires_in ?? 900) * 1000;
      pollDeviceFlow(data.device_code, data.interval ?? 5, expiresAt, oauthPollAbort.signal)
        .catch((e) => log.warn('bugreport', 'Device flow polling failed unexpectedly', { error: String(e) }));
      return { ok: true, user_code: data.user_code, verification_uri: data.verification_uri, expires_in: data.expires_in };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('bugreport:signOut', () => {
    oauthPollAbort?.abort();
    oauthPollAbort = null;
    clearGithubTokens();
    return { ok: true };
  });

  ipcMain.handle('bugreport:hasToken', () => !!getGithubToken());

  ipcMain.handle('bugreport:checkToken', async () => {
    let token = getGithubToken();
    if (!token) return { valid: false };
    const probe = (t: string) => net.fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${t}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'TesterBrowser-BugReporter' },
    });
    try {
      let res = await probe(token);
      if (res.status === 401) {
        token = await refreshGithubToken();
        if (!token) return { valid: false };
        res = await probe(token);
        if (res.status === 401) { clearGithubTokens(); return { valid: false }; }
      }
      return { valid: res.ok };
    } catch { return { valid: false }; }
  });

  ipcMain.handle('bugreport:saveToken', (_e, token: string) => {
    const trimmed = (token ?? '').trim();
    if (!trimmed) { clearGithubTokens(); return { ok: true }; }
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS-level secure storage is unavailable on this system — cannot store the token safely.' };
    }
    // A manually-pasted token replaces any device-flow tokens; it has no refresh token of its own.
    bugReportStore.set({
      tokenEnc: safeStorage.encryptString(trimmed).toString('base64'),
      refreshTokenEnc: null,
      refreshExpiresAt: null,
    });
    return { ok: true };
  });

  // #226: shared by getDiagnosticsData() (bug-report path, below) and the
  // applog:tail IPC handler (registered separately, in ipc/applog.ts) — the
  // same underlying tail the bug report's "App log" block is built from.
  function getCappedAppLog(): { text: string; truncated: boolean } {
    return capLogBlock(readLogTail(getLogsDir(), 200), 30_000);
  }

  function getDiagnosticsData() {
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      recentErrors: getRecentErrors().slice(-10),
      appLog: getCappedAppLog(),
    };
  }

  ipcMain.handle('bugreport:getDiagnostics', () => getDiagnosticsData());

  ipcMain.handle('app:captureScreenshot', () => getSessionManager()?.captureAppScreenshot() ?? null);

  // Default diagnostics text — mirrors renderer/bugreport.js's own preview formatting
  // exactly, so what the user sees (and can edit) matches what gets posted verbatim.
  function defaultDiagnosticsText(): string {
    return buildDefaultDiagnosticsText(getDiagnosticsData());
  }

  // Best-effort: finds a GitHub Projects (v2) board titled "Testerbrowser" owned by
  // the repo owner and adds the issue to it. Silently returns false on any failure
  // (missing scope, no such board, etc.) — the issue itself is still created either way.
  async function addIssueToProjectBoard(token: string, issueNodeId: string): Promise<boolean> {
    try {
      const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'TesterBrowser-BugReporter',
      };
      const ownerQuery = `query($owner: String!) {
        repositoryOwner(login: $owner) {
          ... on ProjectV2Owner { projectsV2(first: 20) { nodes { id title } } }
        }
      }`;
      const res1 = await net.fetch('https://api.github.com/graphql', {
        method: 'POST', headers,
        body: JSON.stringify({ query: ownerQuery, variables: { owner: GH_REPO_OWNER } }),
      });
      const json1 = await res1.json() as { data?: { repositoryOwner?: { projectsV2?: { nodes?: { id: string; title: string }[] } } } };
      const nodes = json1.data?.repositoryOwner?.projectsV2?.nodes ?? [];
      const projectId = findProjectBoardId(nodes);
      if (!projectId) return false;

      const mutation = `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } }
      }`;
      const res2 = await net.fetch('https://api.github.com/graphql', {
        method: 'POST', headers,
        body: JSON.stringify({ query: mutation, variables: { projectId, contentId: issueNodeId } }),
      });
      const json2 = await res2.json();
      return projectItemWasAdded(json2);
    } catch { return false; }
  }

  ipcMain.handle('bugreport:submit', async (_e, payload: { area: string; description: string; diagnostics?: string; screenshotB64?: string | null }) => {
    let token = getGithubToken();
    if (!token) return { ok: false, error: 'No GitHub token configured. Add one in Settings.' };
    if (!payload?.description?.trim()) return { ok: false, error: 'Description is required.' };

    const title = buildBugReportTitle(payload.area, payload.description);
    const diagnosticsText = payload.diagnostics?.trim() || defaultDiagnosticsText();
    // #226: caps the final body at 60,000 chars, truncating diagnostics (which
    // carries the app-log block at its own tail) rather than the user's
    // description — never the other way around.
    const body = capIssueBody(payload.description.trim(), wrapDiagnosticsMarkdown(payload.area, diagnosticsText), 60_000);

    try {
      const createIssue = (t: string) => net.fetch(`https://api.github.com/repos/${GH_REPO_OWNER}/${GH_REPO_NAME}/issues`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${t}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'TesterBrowser-BugReporter',
        },
        body: JSON.stringify({ title, body, labels: ['status-ready'] }),
      });
      let res = await createIssue(token);
      if (res.status === 401) {
        const refreshed = await refreshGithubToken();
        if (!refreshed) return { ok: false, error: 'GitHub token is invalid or expired. Please sign in again in Settings.' };
        token = refreshed;
        res = await createIssue(token);
      }
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        if (res.status === 401) {
          clearGithubTokens();
          return { ok: false, error: 'GitHub token is invalid or expired. Please sign in again in Settings.' };
        }
        return { ok: false, error: (data as { message?: string }).message ?? `HTTP ${res.status}` };
      }

      // #246: 'status-ready' is silently dropped for a token without triage
      // access — surfaced back rather than assumed, so the confirmation text
      // can say so instead of implying the board/queue picked it up.
      const appliedLabels = Array.isArray(data.labels)
        ? (data.labels as { name?: string }[]).map((l) => l.name)
        : [];
      const labelApplied = appliedLabels.includes('status-ready');

      let screenshotAttached = false;
      let screenshotError: string | null = null;
      let screenshotSavedPath: string | null = null;
      if (payload.screenshotB64) {
        try {
          // #246: the OAuth device flow only ever requests public_repo, so the
          // Contents-API upload (which needs push) silently fails for most
          // users — check first, rather than attempting it and surfacing a
          // permission error.
          const permRes = await net.fetch(`https://api.github.com/repos/${GH_REPO_OWNER}/${GH_REPO_NAME}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'TesterBrowser-BugReporter' },
          });
          const permData = await permRes.json().catch(() => ({})) as { permissions?: { push?: boolean } };
          const strategy = decideScreenshotStrategy(!!permData.permissions?.push);

          if (strategy === 'save-locally') {
            const dir = path.join(app.getPath('userData'), 'bug-report-screenshots');
            fs.mkdirSync(dir, { recursive: true });
            const savedPath = path.join(dir, `issue-${data.number}.jpg`);
            fs.writeFileSync(savedPath, Buffer.from(payload.screenshotB64, 'base64'));
            screenshotSavedPath = savedPath;
          } else {
            const filePath = `.github/bug-report-screenshots/issue-${data.number}.jpg`;
            const putRes = await net.fetch(`https://api.github.com/repos/${GH_REPO_OWNER}/${GH_REPO_NAME}/contents/${filePath}`, {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'User-Agent': 'TesterBrowser-BugReporter',
              },
              body: JSON.stringify({ message: `Bug report screenshot for #${data.number}`, content: payload.screenshotB64 }),
            });
            if (!putRes.ok) {
              const putData = await putRes.json().catch(() => ({})) as { message?: string };
              screenshotError = putData.message ?? `Upload failed: HTTP ${putRes.status}`;
            } else {
              const screenshotUrl = `https://raw.githubusercontent.com/${GH_REPO_OWNER}/${GH_REPO_NAME}/main/${filePath}`;
              const patchRes = await net.fetch(`https://api.github.com/repos/${GH_REPO_OWNER}/${GH_REPO_NAME}/issues/${data.number}`, {
                method: 'PATCH',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Accept': 'application/vnd.github+json',
                  'Content-Type': 'application/json',
                  'User-Agent': 'TesterBrowser-BugReporter',
                },
                body: JSON.stringify({ body: `${body}\n\n![TesterBrowser screenshot](${screenshotUrl})` }),
              });
              if (patchRes.ok) {
                screenshotAttached = true;
              } else {
                const patchData = await patchRes.json().catch(() => ({})) as { message?: string };
                screenshotError = patchData.message ?? `Embedding failed: HTTP ${patchRes.status}`;
              }
            }
          }
        } catch (e: unknown) {
          screenshotError = e instanceof Error ? e.message : String(e);
        }
      }

      const boardAdded = await addIssueToProjectBoard(token, data.node_id as string);
      log.info('bugreport', `Bug report submitted: issue #${data.number}`);
      return {
        ok: true, url: data.html_url, number: data.number, boardAdded,
        screenshotAttached, screenshotError, screenshotSavedPath, labelApplied,
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log.error('bugreport', `Bug report submission failed: ${message}`);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('bugreport:revealScreenshot', (_e, filePath: string) => {
    // L5: resolved + path.relative containment, not a string prefix — a
    // prefix check let '..' segments and sibling dirs sharing the prefix
    // ("bug-report-screenshots-evil") through.
    if (isPathInside(filePath, path.join(app.getPath('userData'), 'bug-report-screenshots'))) {
      shell.showItemInFolder(path.resolve(filePath));
    }
  });
}
