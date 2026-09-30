import { ipcMain, net, safeStorage } from 'electron';
import {
  toPublicJiraSettings, parseJiraResponse, DEFAULT_JIRA_SETTINGS, JiraSettingsFile,
  formatConsoleErrors, checkAttachmentSize, JiraAttachmentUploadResult,
  validateJiraBaseUrl, resolveJiraTokenOnSave,
} from '../jira';
import type { JsonStore } from '../jsonFile';
import type { AppDeps } from './deps';

export interface JiraIpcStores {
  jiraStore: JsonStore<JiraSettingsFile>;
}

// The Jira API token is encrypted at rest via OS-level safeStorage (DPAPI /
// Keychain / libsecret), the same as the GitHub bug-reporter token — only
// the ciphertext touches disk, and jira:getSettings never returns it to the
// renderer (see toPublicJiraSettings).
function getJiraToken(jiraStore: JsonStore<JiraSettingsFile>): string | null {
  const s = jiraStore.get();
  if (!s.apiTokenEnc || !safeStorage.isEncryptionAvailable()) return null;
  // M3: a base URL saved before https was enforced never gets the token.
  if (!s.baseUrl || validateJiraBaseUrl(s.baseUrl).error !== undefined) return null;
  try { return safeStorage.decryptString(Buffer.from(s.apiTokenEnc, 'base64')); } catch { return null; }
}

function jiraAuthHeader(email: string, token: string): string {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function jiraFetch(url: string, init: Parameters<typeof net.fetch>[1]) {
  const res = await net.fetch(url, init);
  const contentType = res.headers.get('content-type');
  const text = await res.text();
  return parseJiraResponse(res.status, res.statusText, contentType, text);
}

interface JiraAttachOptions { screenshot: boolean; harMinutes: number | null; consoleErrors: boolean; steps: boolean; }

// #245: one multipart POST per file, field name "file" — Jira Cloud's
// attachment endpoint requires the X-Atlassian-Token: no-check header (it
// otherwise rejects the request as a suspected XSRF attack) and returns a
// non-2xx (e.g. 413) for an attachment the site itself rejects, which is
// reported back rather than thrown.
async function uploadJiraAttachment(
  baseUrl: string, email: string, token: string, issueKey: string,
  filename: string, data: Buffer, contentType: string
): Promise<JiraAttachmentUploadResult> {
  const tooLarge = checkAttachmentSize(filename, data.byteLength);
  if (tooLarge) return tooLarge;
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type: contentType }), filename);
    const res = await net.fetch(`${baseUrl.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`, {
      method: 'POST',
      headers: { 'Authorization': jiraAuthHeader(email, token), 'X-Atlassian-Token': 'no-check', 'Accept': 'application/json' },
      body: form,
    });
    if (!res.ok) return { filename, ok: false, reason: `${res.status} ${res.statusText || 'error'}`.trim() };
    return { filename, ok: true };
  } catch (e) {
    return { filename, ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Jira integration IPC — settings, ticket fetch, and issue creation with evidence attachments (#245). */
export function registerJiraIpc(deps: AppDeps, stores: JiraIpcStores): void {
  const { getSessionManager } = deps;
  const { jiraStore } = stores;

  // Builds every evidence file the caller asked for (#245) — each builder is
  // independent and best-effort, so one failing to produce data (e.g. no
  // steps recorded) just means that file is left out, not that the whole
  // attach step fails.
  async function buildJiraEvidenceFiles(sessionId: string, attach: JiraAttachOptions): Promise<{ filename: string; data: Buffer; contentType: string }[]> {
    const files: { filename: string; data: Buffer; contentType: string }[] = [];
    const sessionManager = getSessionManager();
    if (!sessionManager) return files;

    if (attach.screenshot) {
      const png = await sessionManager.capturePageScreenshot(sessionId);
      if (png) files.push({ filename: 'screenshot.png', data: png, contentType: 'image/png' });
    }
    if (attach.harMinutes != null) {
      const sinceTs = Date.now() - attach.harMinutes * 60_000;
      const harJson = sessionManager.buildHarSince(sessionId, sinceTs);
      if (harJson) files.push({ filename: 'network.har', data: Buffer.from(harJson, 'utf-8'), contentType: 'application/json' });
    }
    if (attach.consoleErrors) {
      const text = formatConsoleErrors(sessionManager.getConsoleErrorRows(sessionId));
      if (text) files.push({ filename: 'console-errors.txt', data: Buffer.from(text, 'utf-8'), contentType: 'text/plain' });
    }
    if (attach.steps) {
      const steps = sessionManager.getEvidenceSteps(sessionId);
      if (steps.length) files.push({ filename: 'steps.json', data: Buffer.from(JSON.stringify(steps, null, 2), 'utf-8'), contentType: 'application/json' });
    }
    return files;
  }

  ipcMain.handle('jira:getSettings', () => toPublicJiraSettings(jiraStore.get()));

  ipcMain.handle('jira:saveSettings', (_e, s: { baseUrl: string; email: string; projectKey: string; issueType: string; apiToken?: string }) => {
    const current = jiraStore.get();
    // M3: https only — the token rides along as Basic auth to this host.
    const validated = validateJiraBaseUrl(s?.baseUrl);
    if (validated.error !== undefined) return { ok: false, error: validated.error };
    const baseUrl = validated.baseUrl;
    let newTokenEnc: string | null = null;
    // An empty token field means "keep the current token" — only a non-empty
    // value replaces it, and replacing it requires OS-level secure storage to
    // actually be available (the GitHub bug-reporter token path works the
    // same way), since a token is never written to disk in plain text.
    const trimmedToken = (s.apiToken ?? '').trim();
    if (trimmedToken) {
      if (!safeStorage.isEncryptionAvailable()) {
        return { ok: false, error: 'OS-level secure storage is unavailable on this system — cannot store the token safely.' };
      }
      newTokenEnc = safeStorage.encryptString(trimmedToken).toString('base64');
    }
    // M3: a kept token is dropped if the base URL now points at another host.
    const apiTokenEnc = resolveJiraTokenOnSave(current.baseUrl, baseUrl, current.apiTokenEnc, newTokenEnc);
    jiraStore.set({
      baseUrl,
      email: (s.email ?? '').trim(),
      projectKey: (s.projectKey ?? '').trim().toUpperCase(),
      issueType: (s.issueType ?? '').trim() || DEFAULT_JIRA_SETTINGS.issueType,
      apiTokenEnc,
    });
    return { ok: true };
  });

  ipcMain.handle('jira:fetchTicket', async (_e, key: string) => {
    const s = jiraStore.get();
    const token = getJiraToken(jiraStore);
    if (!s.baseUrl || !s.email || !token) return { ok: false, error: 'Jira not configured' };
    try {
      return await jiraFetch(
        `${s.baseUrl.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(key)}`,
        { headers: { 'Authorization': jiraAuthHeader(s.email, token), 'Accept': 'application/json' } }
      );
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('jira:createIssue', async (_e, summary: string, description: string, opts?: { linkTo?: string; sessionId?: string; attach?: JiraAttachOptions }) => {
    const s = jiraStore.get();
    const token = getJiraToken(jiraStore);
    if (!s.baseUrl || !s.email || !token || !s.projectKey) return { ok: false, error: 'Jira not configured' };
    try {
      const body = {
        fields: {
          project: { key: s.projectKey },
          summary,
          description: {
            version: 1, type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
          },
          issuetype: { name: s.issueType || DEFAULT_JIRA_SETTINGS.issueType },
        },
      };
      const authHeaders = {
        'Authorization': jiraAuthHeader(s.email, token),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      };
      const result = await jiraFetch(`${s.baseUrl.replace(/\/$/, '')}/rest/api/3/issue`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify(body),
      });
      if (!result.ok) return result;
      const key = (result.data as { key?: string } | undefined)?.key;
      if (!key) return { ok: false, error: 'Jira did not return an issue key' };

      // A link failure never fails the creation — the bug already exists.
      let linkError: string | undefined;
      if (opts?.linkTo) {
        const linkResult = await jiraFetch(`${s.baseUrl.replace(/\/$/, '')}/rest/api/3/issueLink`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            type: { name: 'Relates' },
            inwardIssue: { key },
            outwardIssue: { key: opts.linkTo },
          }),
        });
        if (!linkResult.ok) linkError = linkResult.error;
      }

      // Attachments are best-effort and never retroactively fail the issue
      // that already exists — each file's own outcome is reported instead.
      let attachments: JiraAttachmentUploadResult[] | undefined;
      if (opts?.attach && opts.sessionId) {
        const files = await buildJiraEvidenceFiles(opts.sessionId, opts.attach);
        attachments = [];
        for (const f of files) {
          attachments.push(await uploadJiraAttachment(s.baseUrl, s.email, token, key, f.filename, f.data, f.contentType));
        }
      }

      return { ok: true, key, linkError, attachments };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
