import {
  migrateJiraSettings, toPublicJiraSettings, parseJiraResponse, DEFAULT_JIRA_SETTINGS,
  filterRowsSince, formatConsoleErrors, checkAttachmentSize, summarizeAttachmentResults,
  JIRA_ATTACHMENT_MAX_BYTES,
} from '../jira';
import type { EventRow } from '../recorder';

function row(kind: EventRow['kind'], ts: number, payload: unknown): EventRow {
  return { session_id: 's1', ts, kind, summary: '', payload: JSON.stringify(payload) };
}

describe('parseJiraResponse (#267 — safe error parsing)', () => {
  it('returns ok:true with the parsed body on a 201 JSON success', () => {
    const result = parseJiraResponse(201, 'Created', 'application/json;charset=UTF-8', JSON.stringify({ key: 'TEST-2' }));
    expect(result).toEqual({ ok: true, data: { key: 'TEST-2' } });
  });

  it('joins Jira\'s errorMessages onto the HTTP status for a JSON error body', () => {
    const result = parseJiraResponse(400, 'Bad Request', 'application/json', JSON.stringify({ errorMessages: ['Field is required'] }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HTTP 400 Bad Request: Field is required');
  });

  it('joins Jira\'s errors{} values too, alongside errorMessages', () => {
    const result = parseJiraResponse(400, 'Bad Request', 'application/json', JSON.stringify({
      errorMessages: ['Top-level problem'],
      errors: { summary: 'Summary is required' },
    }));
    expect(result.error).toBe('HTTP 400 Bad Request: Top-level problem; Summary is required');
  });

  it('falls back to a plain HTTP status when the body is HTML (e.g. an SSO redirect or a proxy error page)', () => {
    const result = parseJiraResponse(502, 'Bad Gateway', 'text/html; charset=UTF-8', '<html><body>Bad Gateway</body></html>');
    expect(result).toEqual({ ok: false, error: 'HTTP 502 Bad Gateway' });
  });

  it('falls back to a plain HTTP status when the content type is JSON but the body fails to parse', () => {
    const result = parseJiraResponse(500, 'Internal Server Error', 'application/json', 'not actually json{');
    expect(result).toEqual({ ok: false, error: 'HTTP 500 Internal Server Error' });
  });

  it('treats any 2xx as success', () => {
    expect(parseJiraResponse(200, 'OK', 'application/json', '{}').ok).toBe(true);
    expect(parseJiraResponse(204, 'No Content', null, '').ok).toBe(true);
  });
});

describe('migrateJiraSettings (#267 — plaintext token migration)', () => {
  it('migrates a legacy plaintext apiToken to an encrypted apiTokenEnc', () => {
    const encryptString = jest.fn((s: string) => Buffer.from(`enc(${s})`));
    const { settings, migrated } = migrateJiraSettings(
      { baseUrl: 'https://x.atlassian.net', email: 'a@b.com', projectKey: 'PROJ', apiToken: 'secret-token' },
      encryptString,
      () => true
    );
    expect(migrated).toBe(true);
    expect(encryptString).toHaveBeenCalledWith('secret-token');
    expect(settings.apiTokenEnc).toBe(Buffer.from('enc(secret-token)').toString('base64'));
    // The plaintext field never survives into the returned settings shape.
    expect((settings as unknown as { apiToken?: string }).apiToken).toBeUndefined();
  });

  it('does not migrate when encryption is unavailable — leaves apiTokenEnc unset rather than ever writing plaintext', () => {
    const encryptString = jest.fn();
    const { settings, migrated } = migrateJiraSettings(
      { apiToken: 'secret-token' },
      encryptString,
      () => false
    );
    expect(migrated).toBe(false);
    expect(encryptString).not.toHaveBeenCalled();
    expect(settings.apiTokenEnc).toBeNull();
  });

  it('is a no-op when apiTokenEnc is already set — never re-encrypts or touches an already-migrated file', () => {
    const encryptString = jest.fn();
    const { settings, migrated } = migrateJiraSettings(
      { apiTokenEnc: 'already-encrypted==' },
      encryptString,
      () => true
    );
    expect(migrated).toBe(false);
    expect(encryptString).not.toHaveBeenCalled();
    expect(settings.apiTokenEnc).toBe('already-encrypted==');
  });

  it('is a no-op when there is no plaintext token to migrate at all (fresh install)', () => {
    const { settings, migrated } = migrateJiraSettings(null, jest.fn(), () => true);
    expect(migrated).toBe(false);
    expect(settings).toEqual(DEFAULT_JIRA_SETTINGS);
  });

  it('preserves the other fields (baseUrl/email/projectKey/issueType) across migration', () => {
    const { settings } = migrateJiraSettings(
      { baseUrl: 'https://x.atlassian.net', email: 'a@b.com', projectKey: 'PROJ', issueType: 'Defect', apiToken: 't' },
      (s) => Buffer.from(s),
      () => true
    );
    expect(settings.baseUrl).toBe('https://x.atlassian.net');
    expect(settings.email).toBe('a@b.com');
    expect(settings.projectKey).toBe('PROJ');
    expect(settings.issueType).toBe('Defect');
  });
});

describe('toPublicJiraSettings (#267 — token never reaches the renderer)', () => {
  it('reports hasToken:true and omits the token/ciphertext when apiTokenEnc is set', () => {
    const pub = toPublicJiraSettings({ baseUrl: 'https://x.atlassian.net', email: 'a@b.com', projectKey: 'PROJ', issueType: 'Bug', apiTokenEnc: 'ciphertext==' });
    expect(pub).toEqual({ baseUrl: 'https://x.atlassian.net', email: 'a@b.com', projectKey: 'PROJ', issueType: 'Bug', hasToken: true });
    expect(Object.keys(pub)).not.toContain('apiTokenEnc');
    expect(Object.keys(pub)).not.toContain('apiToken');
  });

  it('reports hasToken:false when no token is set', () => {
    const pub = toPublicJiraSettings(DEFAULT_JIRA_SETTINGS);
    expect(pub.hasToken).toBe(false);
  });
});

describe('filterRowsSince (#245 — HAR "last N minutes" window)', () => {
  it('keeps rows at or after sinceTs (inclusive boundary)', () => {
    const rows = [{ ts: 100 }, { ts: 200 }, { ts: 300 }];
    expect(filterRowsSince(rows, 200)).toEqual([{ ts: 200 }, { ts: 300 }]);
  });

  it('drops everything strictly before sinceTs', () => {
    const rows = [{ ts: 100 }, { ts: 199 }];
    expect(filterRowsSince(rows, 200)).toEqual([]);
  });

  it('keeps everything when sinceTs predates all rows', () => {
    const rows = [{ ts: 100 }, { ts: 200 }];
    expect(filterRowsSince(rows, 0)).toEqual(rows);
  });
});

describe('formatConsoleErrors (#245 — console-errors.txt attachment)', () => {
  it('includes console rows of type error and assert, but not log/info/warning', () => {
    const rows = [
      row('console', 1000, { type: 'error', args: [{ value: 'boom' }] }),
      row('console', 2000, { type: 'assert', args: [{ value: 'assertion failed' }] }),
      row('console', 3000, { type: 'log', args: [{ value: 'ignored' }] }),
      row('console', 4000, { type: 'warning', args: [{ value: 'also ignored' }] }),
    ];
    const text = formatConsoleErrors(rows);
    expect(text).toContain('[console/error]  boom');
    expect(text).toContain('[console/assert]  assertion failed');
    expect(text).not.toContain('ignored');
  });

  it('includes log rows only at level error', () => {
    const rows = [
      row('log', 1000, { entry: { level: 'error', text: 'log error' } }),
      row('log', 2000, { entry: { level: 'warning', text: 'log warning' } }),
      row('log', 3000, { entry: { level: 'info', text: 'log info' } }),
    ];
    const text = formatConsoleErrors(rows);
    expect(text).toContain('[log/error]  log error');
    expect(text).not.toContain('log warning');
    expect(text).not.toContain('log info');
  });

  it('includes every exception row, with the stack appended', () => {
    const rows = [
      row('exception', 1000, { exceptionDetails: { text: 'Uncaught TypeError', exception: { description: 'TypeError: x is not a function\n  at foo (app.js:1:1)' } } }),
    ];
    const text = formatConsoleErrors(rows);
    expect(text).toContain('[exception]  Uncaught TypeError');
    expect(text).toContain('TypeError: x is not a function');
    expect(text).toContain('at foo (app.js:1:1)');
  });

  it('formats each line as ISO-time  [kind]  text', () => {
    const rows = [row('log', 1700000000000, { entry: { level: 'error', text: 'oops' } })];
    const text = formatConsoleErrors(rows);
    expect(text).toBe(`${new Date(1700000000000).toISOString()}  [log/error]  oops`);
  });

  it('ignores rows with unparseable payloads instead of throwing', () => {
    const bad: EventRow = { session_id: 's1', ts: 1000, kind: 'exception', summary: '', payload: 'not json' };
    expect(() => formatConsoleErrors([bad])).not.toThrow();
    expect(formatConsoleErrors([bad])).toBe('');
  });

  it('caps the output near the byte limit, dropping the oldest lines first', () => {
    const rows: EventRow[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(row('log', 1000 + i, { entry: { level: 'error', text: `line-${i}-` + 'x'.repeat(100) } }));
    }
    const capped = formatConsoleErrors(rows, 500);
    expect(capped).not.toContain('line-0-');
    expect(capped).toContain('line-19-');
    expect(Buffer.byteLength(capped, 'utf-8')).toBeLessThanOrEqual(600); // cap + one line's slack
  });

  it('returns an empty string when there is nothing matching', () => {
    const rows = [row('console', 1000, { type: 'log', args: [] })];
    expect(formatConsoleErrors(rows)).toBe('');
  });
});

describe('checkAttachmentSize (#245 — 10 MB attachment cap)', () => {
  it('returns null (proceed) for a file at or under the limit', () => {
    expect(checkAttachmentSize('a.png', JIRA_ATTACHMENT_MAX_BYTES)).toBeNull();
    expect(checkAttachmentSize('a.png', 1024)).toBeNull();
  });

  it('reports "skipped: over 10 MB" for a file over the limit, without ever attempting an upload', () => {
    const result = checkAttachmentSize('network.har', JIRA_ATTACHMENT_MAX_BYTES + 1);
    expect(result).toEqual({ filename: 'network.har', ok: false, reason: 'skipped: over 10 MB' });
  });
});

describe('summarizeAttachmentResults (#245 — "attached N/M (...)" message)', () => {
  it('returns an empty string when nothing was attached at all', () => {
    expect(summarizeAttachmentResults([])).toBe('');
  });

  it('reports full success with no parenthetical', () => {
    const results = [
      { filename: 'screenshot.png', ok: true },
      { filename: 'network.har', ok: true },
    ];
    expect(summarizeAttachmentResults(results)).toBe('attached 2/2');
  });

  it('names each failed file and its reason on partial failure', () => {
    const results = [
      { filename: 'screenshot.png', ok: true },
      { filename: 'network.har', ok: false, reason: '413 Payload Too Large' },
      { filename: 'console-errors.txt', ok: true },
      { filename: 'steps.json', ok: false, reason: 'skipped: over 10 MB' },
    ];
    expect(summarizeAttachmentResults(results)).toBe(
      'attached 2/4 (network.har: 413 Payload Too Large, steps.json: skipped: over 10 MB)'
    );
  });
});
