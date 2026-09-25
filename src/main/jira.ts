// Pure Jira helpers (#267) — no Electron imports, so these are directly
// unit-testable. Electron-specific glue (safeStorage, net.fetch, ipcMain)
// stays in index.ts.

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
