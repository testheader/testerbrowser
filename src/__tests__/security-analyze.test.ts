// Regression tests for the Security tab's analyze() — imports the real renderer
// module so a field-name drift (e.g. reading ev.type instead of ev.kind) fails here.
import { analyze } from '../../renderer/security.js';

// Mirrors what SessionRecorder stores: a row with `kind` and a JSON-string `payload`
// holding raw CDP Network.responseReceived params.
function responseEvent(response: Record<string, unknown>) {
  return {
    kind: 'network-response',
    ts: 1700000000000,
    summary: 'test',
    payload: JSON.stringify({ requestId: '1', response }),
  };
}

const secureHeaders = {
  'content-security-policy': "default-src 'self'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000',
  'referrer-policy': 'no-referrer',
};

describe('analyze', () => {
  it('reads the kind field, not type', () => {
    const findings = analyze([
      responseEvent({ url: 'http://example.com/', status: 200, headers: {} }),
    ]);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('ignores events that are not network responses', () => {
    expect(analyze([
      { kind: 'console', ts: 1, summary: 'x', payload: JSON.stringify({ message: 'hi' }) },
      { kind: 'network-request', ts: 2, summary: 'x', payload: JSON.stringify({ request: {} }) },
    ])).toEqual([]);
  });

  it('flags plain HTTP as high severity', () => {
    const findings = analyze([
      responseEvent({ url: 'http://example.com/', status: 200, headers: secureHeaders }),
    ]);
    expect(findings).toContainEqual(expect.objectContaining({
      severity: 'high',
      issue: 'HTTP (unencrypted)',
      url: 'http://example.com/',
    }));
  });

  it('reports each missing security header on an HTTPS response', () => {
    const findings = analyze([
      responseEvent({ url: 'https://example.com/', status: 200, headers: {} }),
    ]);
    const issues = findings.map(f => f.issue);
    expect(issues).toEqual(expect.arrayContaining([
      'Missing content-security-policy',
      'Missing x-frame-options',
      'Missing x-content-type-options',
      'Missing strict-transport-security',
      'Missing referrer-policy',
    ]));
  });

  it('reports nothing for a fully secured HTTPS response', () => {
    expect(analyze([
      responseEvent({ url: 'https://example.com/', status: 200, headers: secureHeaders }),
    ])).toEqual([]);
  });

  it('matches headers case-insensitively', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: {
          'Content-Security-Policy': "default-src 'self'",
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
          'Strict-Transport-Security': 'max-age=31536000',
          'Referrer-Policy': 'no-referrer',
        },
      }),
    ]);
    expect(findings).toEqual([]);
  });

  it('flags cookies missing Secure and HttpOnly', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: { ...secureHeaders, 'set-cookie': 'sid=abc; Path=/' },
      }),
    ]);
    const issues = findings.map(f => f.issue);
    expect(issues).toContain('Insecure cookie');
    expect(issues).toContain('Cookie missing HttpOnly');
  });

  it('accepts a cookie carrying both flags', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: { ...secureHeaders, 'set-cookie': 'sid=abc; Path=/; Secure; HttpOnly' },
      }),
    ]);
    expect(findings).toEqual([]);
  });

  it('does not flag cookie flags when the value was redacted', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: { ...secureHeaders, 'set-cookie': '[REDACTED]' },
      }),
    ]);
    expect(findings).toEqual([]);
  });

  it('flags auth failures', () => {
    for (const status of [401, 403]) {
      const findings = analyze([
        responseEvent({ url: 'https://example.com/api', status, headers: secureHeaders }),
      ]);
      expect(findings).toContainEqual(expect.objectContaining({
        severity: 'low',
        issue: `Auth failure (${status})`,
      }));
    }
  });

  it('reports missing headers once per URL across repeated responses', () => {
    const ev = responseEvent({ url: 'https://example.com/', status: 200, headers: {} });
    const findings = analyze([ev, { ...ev }]);
    expect(findings.filter(f => f.issue === 'Missing x-frame-options')).toHaveLength(1);
  });

  it('skips events whose payload is not valid JSON', () => {
    expect(analyze([
      { kind: 'network-response', ts: 1, summary: 'x', payload: 'not json' },
    ])).toEqual([]);
  });
});
