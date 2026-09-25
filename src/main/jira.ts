import type { EventRow } from './recorder';

// Pure Jira helpers (#267, #245) — no Electron imports, so these are
// directly unit-testable. Electron-specific glue (safeStorage, net.fetch,
// ipcMain) stays in index.ts.

export interface JiraSettingsFile {
  baseUrl: string;
  email: string;
  projectKey: string;
  issueType: string;
  apiTokenEnc: string | null;
}

export interface JiraSettingsPublic {
  baseUrl: string;
  email: string;
  projectKey: string;
  issueType: string;
  hasToken: boolean;
}

export const DEFAULT_JIRA_SETTINGS: JiraSettingsFile = {
  baseUrl: '', email: '', projectKey: '', issueType: 'Bug', apiTokenEnc: null,
};

// Migrates a pre-#267 plaintext `apiToken` field (if present, and there's no
// apiTokenEnc yet) into an encrypted apiTokenEnc, dropping the plaintext
// field from the returned settings. Pure — takes safeStorage's own methods
// as injected functions so this is testable without booting Electron.
export function migrateJiraSettings(
  raw: unknown,
  encryptString: (plainText: string) => Buffer,
  isEncryptionAvailable: () => boolean
): { settings: JiraSettingsFile; migrated: boolean } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<JiraSettingsFile> & { apiToken?: string };
  const settings: JiraSettingsFile = {
    baseUrl: r.baseUrl ?? DEFAULT_JIRA_SETTINGS.baseUrl,
    email: r.email ?? DEFAULT_JIRA_SETTINGS.email,
    projectKey: r.projectKey ?? DEFAULT_JIRA_SETTINGS.projectKey,
    issueType: r.issueType ?? DEFAULT_JIRA_SETTINGS.issueType,
    apiTokenEnc: r.apiTokenEnc ?? null,
  };
  let migrated = false;
  if (r.apiToken && !settings.apiTokenEnc && isEncryptionAvailable()) {
    settings.apiTokenEnc = encryptString(r.apiToken).toString('base64');
    migrated = true;
  }
  return { settings, migrated };
}

// Never includes the token or its ciphertext — only whether one is set.
export function toPublicJiraSettings(s: JiraSettingsFile): JiraSettingsPublic {
  return { baseUrl: s.baseUrl, email: s.email, projectKey: s.projectKey, issueType: s.issueType, hasToken: !!s.apiTokenEnc };
}

export interface JiraParseResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// Reads the response body as text first and only JSON.parses it when the
// content type says JSON — a Jira-fronting proxy/SSO redirect/502 can return
// an HTML error page, and calling res.json() straight away throws a JSON
// syntax error instead of surfacing the real HTTP status. On a non-2xx
// status, joins Jira's own errorMessages[]/errors{} onto the HTTP status
// when they're present in a successfully-parsed JSON body.
export function parseJiraResponse(status: number, statusText: string, contentType: string | null, text: string): JiraParseResult {
  const isJson = !!contentType && contentType.toLowerCase().includes('json');
  let data: unknown;
  if (isJson && text) {
    try { data = JSON.parse(text); } catch { data = undefined; }
  }
  if (status < 200 || status >= 300) {
    let error = `HTTP ${status} ${statusText}`.trim();
    if (data && typeof data === 'object') {
      const d = data as { errorMessages?: unknown; errors?: unknown };
      const msgs: string[] = [];
      if (Array.isArray(d.errorMessages)) {
        msgs.push(...d.errorMessages.filter((m): m is string => typeof m === 'string'));
      }
      if (d.errors && typeof d.errors === 'object') {
        msgs.push(...Object.values(d.errors as Record<string, unknown>).filter((m): m is string => typeof m === 'string'));
      }
      if (msgs.length) error += `: ${msgs.join('; ')}`;
    }
    return { ok: false, error };
  }
  return { ok: true, data };
}

// #245: keeps only rows at or after sinceTs — used both for the HAR
// attachment's "last N minutes" window and directly unit-tested for its
// inclusive boundary.
export function filterRowsSince<T extends { ts: number }>(rows: T[], sinceTs: number): T[] {
  return rows.filter((r) => r.ts >= sinceTs);
}

const CONSOLE_ERROR_LOG_CAP_BYTES = 1_000_000;

// #245: formats the active tab's console/log/exception rows into the
// console-errors.txt bug-report attachment — one line per entry as
// `ISO-time  [kind]  text`, with the stack appended for exceptions. Only
// console events of type error/assert, log events at level error, and all
// exception rows are included. Capped at ~1 MB, dropping the *oldest*
// lines first so the most recent errors (most likely relevant to the bug
// being filed) always survive the cap.
export function formatConsoleErrors(rows: EventRow[], capBytes = CONSOLE_ERROR_LOG_CAP_BYTES): string {
  const lines: string[] = [];
  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(row.payload); } catch { continue; }
    const iso = new Date(row.ts).toISOString();
    if (row.kind === 'console') {
      const type = parsed.type;
      if (type !== 'error' && type !== 'assert') continue;
      const args = Array.isArray(parsed.args) ? parsed.args as { value?: unknown; description?: string }[] : [];
      const text = args.map((a) => (a.value ?? a.description ?? '')).join(' ');
      lines.push(`${iso}  [console/${type}]  ${text}`);
    } else if (row.kind === 'log') {
      const entry = parsed.entry as { level?: string; text?: string } | undefined;
      if (entry?.level !== 'error') continue;
      lines.push(`${iso}  [log/error]  ${entry.text ?? ''}`);
    } else if (row.kind === 'exception') {
      const details = parsed.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      const text = details?.text ?? 'Uncaught exception';
      const stack = details?.exception?.description;
      lines.push(`${iso}  [exception]  ${text}${stack ? '\n' + stack : ''}`);
    }
  }

  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineSize = Buffer.byteLength(lines[i], 'utf-8') + 1;
    if (size + lineSize > capBytes && kept.length > 0) break;
    kept.push(lines[i]);
    size += lineSize;
  }
  kept.reverse();
  return kept.join('\n');
}

export const JIRA_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export interface JiraAttachmentUploadResult {
  filename: string;
  ok: boolean;
  reason?: string;
}

// #245: a file over the 10 MB safe default is never uploaded — reported
// back the same shape a real upload attempt would be, so the caller doesn't
// need a separate code path for "too big to try".
export function checkAttachmentSize(filename: string, byteLength: number): JiraAttachmentUploadResult | null {
  if (byteLength > JIRA_ATTACHMENT_MAX_BYTES) {
    return { filename, ok: false, reason: 'skipped: over 10 MB' };
  }
  return null;
}

// #245: builds the one-line result summary appended after "Created: KEY",
// e.g. "attached 3/4 (network.har: 413 too large)". Returns '' when there
// was nothing to attach at all (no evidence checkboxes were selected).
export function summarizeAttachmentResults(results: JiraAttachmentUploadResult[]): string {
  if (results.length === 0) return '';
  const attached = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  let summary = `attached ${attached}/${results.length}`;
  if (failed.length) summary += ` (${failed.map((f) => `${f.filename}: ${f.reason}`).join(', ')})`;
  return summary;
}
