import { validateImportedMockRules } from '../mockManager';

function validFile(rules: unknown[] = []) {
  return { testerBrowserMocks: 1, rules };
}

describe('validateImportedMockRules (#264)', () => {
  it('accepts a valid file with a fully-populated rule', () => {
    const result = validateImportedMockRules(validFile([
      {
        urlPattern: '*/api/widgets',
        method: 'GET',
        statusCode: 200,
        body: '{"ok":true}',
        responseHeaders: { 'content-type': 'application/json' },
        cors: true,
        delayMs: 1500,
        enabled: false,
      },
    ]));

    expect(result.error).toBeUndefined();
    expect(result.skipped).toEqual([]);
    expect(result.rules).toEqual([
      {
        urlPattern: '*/api/widgets',
        method: 'GET',
        statusCode: 200,
        body: '{"ok":true}',
        responseHeaders: { 'content-type': 'application/json' },
        cors: true,
        delayMs: 1500,
        enabled: false,
      },
    ]);
  });

  it('defaults enabled to true and responseHeaders to {} when omitted', () => {
    const result = validateImportedMockRules(validFile([
      { urlPattern: '*/api/*', method: '*', statusCode: 200, body: '' },
    ]));

    expect(result.rules[0].enabled).toBe(true);
    expect(result.rules[0].responseHeaders).toEqual({});
  });

  it('drops unknown fields from an otherwise-valid rule', () => {
    const result = validateImportedMockRules(validFile([
      { urlPattern: '*/api/*', method: 'GET', statusCode: 200, body: '', id: 'attacker-supplied', hitCount: 999, extra: 'nope' },
    ]));

    expect(result.rules[0]).not.toHaveProperty('id');
    expect(result.rules[0]).not.toHaveProperty('hitCount');
    expect(result.rules[0]).not.toHaveProperty('extra');
  });

  it('rejects a file missing the testerBrowserMocks marker', () => {
    const result = validateImportedMockRules({ rules: [] });
    expect(result.error).toBeTruthy();
    expect(result.rules).toEqual([]);
  });

  it('rejects a plain array (no marker at all)', () => {
    const result = validateImportedMockRules([{ urlPattern: '*' }]);
    expect(result.error).toBeTruthy();
  });

  it('rejects null and primitives', () => {
    expect(validateImportedMockRules(null).error).toBeTruthy();
    expect(validateImportedMockRules('not json').error).toBeTruthy();
    expect(validateImportedMockRules(42).error).toBeTruthy();
  });

  it('rejects a file whose rules field is not an array', () => {
    const result = validateImportedMockRules({ testerBrowserMocks: 1, rules: 'nope' });
    expect(result.error).toBeTruthy();
  });

  it('skips a rule with a bad statusCode, naming the index and reason', () => {
    const result = validateImportedMockRules(validFile([
      { urlPattern: '*/api/*', method: 'GET', statusCode: 999, body: '' },
    ]));
    expect(result.rules).toEqual([]);
    expect(result.skipped).toEqual([{ index: 0, reason: expect.stringContaining('statusCode') }]);
  });

  it('skips a rule with a non-integer statusCode', () => {
    const result = validateImportedMockRules(validFile([
      { urlPattern: '*/api/*', method: 'GET', statusCode: 200.5, body: '' },
    ]));
    expect(result.skipped).toHaveLength(1);
  });

  it('skips a rule with an empty urlPattern', () => {
    const result = validateImportedMockRules(validFile([
      { urlPattern: '', method: 'GET', statusCode: 200, body: '' },
    ]));
    expect(result.skipped[0].reason).toContain('urlPattern');
  });

  it('skips a rule with a non-string method', () => {
    const result = validateImportedMockRules(validFile([
      { urlPattern: '*/api/*', method: 42, statusCode: 200, body: '' },
    ]));
    expect(result.skipped[0].reason).toContain('method');
  });

  it('skips a rule with a non-string body', () => {
    const result = validateImportedMockRules(validFile([
      { urlPattern: '*/api/*', method: 'GET', statusCode: 200, body: 12345 },
    ]));
    expect(result.skipped[0].reason).toContain('body');
  });

  it('skips a rule whose responseHeaders is not an object of strings', () => {
    const result = validateImportedMockRules(validFile([
      { urlPattern: '*/api/*', method: 'GET', statusCode: 200, body: '', responseHeaders: { a: 1 } },
    ]));
    expect(result.skipped[0].reason).toContain('responseHeaders');
  });

  it('skips a rule with a non-boolean cors', () => {
    const result = validateImportedMockRules(validFile([
      { urlPattern: '*/api/*', method: 'GET', statusCode: 200, body: '', cors: 'yes' },
    ]));
    expect(result.skipped[0].reason).toContain('cors');
  });

  it('skips a rule with a non-number delayMs', () => {
    const result = validateImportedMockRules(validFile([
      { urlPattern: '*/api/*', method: 'GET', statusCode: 200, body: '', delayMs: '1500' },
    ]));
    expect(result.skipped[0].reason).toContain('delayMs');
  });

  it('skips a rule with a non-boolean enabled', () => {
    const result = validateImportedMockRules(validFile([
      { urlPattern: '*/api/*', method: 'GET', statusCode: 200, body: '', enabled: 'yes' },
    ]));
    expect(result.skipped[0].reason).toContain('enabled');
  });

  it('skips a non-object rule entry', () => {
    const result = validateImportedMockRules(validFile(['not-an-object']));
    expect(result.skipped[0]).toEqual({ index: 0, reason: expect.any(String) });
  });

  it('keeps valid rules and skips invalid ones from the same file, preserving original index', () => {
    const result = validateImportedMockRules(validFile([
      { urlPattern: '*/good/*', method: 'GET', statusCode: 200, body: '' },
      { urlPattern: '', method: 'GET', statusCode: 200, body: '' },
      { urlPattern: '*/also-good/*', method: 'POST', statusCode: 201, body: '' },
    ]));

    expect(result.rules.map(r => r.urlPattern)).toEqual(['*/good/*', '*/also-good/*']);
    expect(result.skipped).toEqual([{ index: 1, reason: expect.any(String) }]);
  });

  it('returns an empty result for an empty rules array', () => {
    const result = validateImportedMockRules(validFile([]));
    expect(result).toEqual({ rules: [], skipped: [] });
  });
});
