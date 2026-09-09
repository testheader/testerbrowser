// Regression tests for the Security tab's analyze() — imports the real renderer
// module so a field-name drift (e.g. reading ev.type instead of ev.kind) fails here.
import { analyze, computeEnabledRuleIds, computeGroupCheckState } from '../../renderer/security.js';

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

// A response that should trip none of the ~28 rules — every existing test
// that expects analyze() to report nothing builds on this.
const secureHeaders = {
  'content-security-policy': "default-src 'self'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  'x-xss-protection': '0',
  'cache-control': 'no-store',
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
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
          'Referrer-Policy': 'no-referrer',
          'Permissions-Policy': 'geolocation=()',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'X-XSS-Protection': '0',
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

  it('accepts a cookie carrying Secure, HttpOnly and SameSite', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: { ...secureHeaders, 'set-cookie': 'sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax' },
      }),
    ]);
    expect(findings).toEqual([]);
  });

  it('flags a cookie missing SameSite', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: { ...secureHeaders, 'set-cookie': 'sid=abc; Secure; HttpOnly' },
      }),
    ]);
    expect(findings.map(f => f.issue)).toContain('Cookie missing SameSite');
  });

  it('flags SameSite=None without Secure as high severity', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: { ...secureHeaders, 'set-cookie': 'sid=abc; HttpOnly; SameSite=None' },
      }),
    ]);
    expect(findings).toContainEqual(expect.objectContaining({
      severity: 'high',
      issue: 'SameSite=None without Secure',
    }));
  });

  it('flags a cookie set without no-store/private caching', () => {
    const { 'cache-control': _omit, ...headersWithoutCacheControl } = secureHeaders;
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: { ...headersWithoutCacheControl, 'set-cookie': 'sid=abc; Secure; HttpOnly; SameSite=Lax' },
      }),
    ]);
    expect(findings.map(f => f.issue)).toContain('Cookie set without no-store/private caching');
  });

  it('flags CSP unsafe-inline, unsafe-eval and wildcard sources', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: { ...secureHeaders, 'content-security-policy': "default-src *; script-src 'unsafe-inline' 'unsafe-eval'" },
      }),
    ]);
    const issues = findings.map(f => f.issue);
    expect(issues).toContain('CSP allows unsafe-inline');
    expect(issues).toContain('CSP allows unsafe-eval');
    expect(issues).toContain('CSP has a wildcard source');
  });

  it('flags X-Frame-Options set to a value other than DENY/SAMEORIGIN', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: { ...secureHeaders, 'x-frame-options': 'ALLOW-FROM https://evil.example' },
      }),
    ]);
    expect(findings.map(f => f.issue)).toContain('X-Frame-Options is not DENY/SAMEORIGIN');
  });

  it('flags a short HSTS max-age and a missing includeSubDomains', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: { ...secureHeaders, 'strict-transport-security': 'max-age=3600' },
      }),
    ]);
    const issues = findings.map(f => f.issue);
    expect(issues).toContain('HSTS max-age is too short');
    expect(issues).toContain('HSTS missing includeSubDomains');
  });

  it('flags Referrer-Policy set to unsafe-url', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: { ...secureHeaders, 'referrer-policy': 'unsafe-url' },
      }),
    ]);
    expect(findings.map(f => f.issue)).toContain('Referrer-Policy is unsafe-url');
  });

  it('flags a Server header that discloses version info, and X-Powered-By when present', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/',
        status: 200,
        headers: { ...secureHeaders, server: 'nginx/1.18.0', 'x-powered-by': 'Express' },
      }),
    ]);
    const issues = findings.map(f => f.issue);
    expect(issues).toContain('Server header discloses version info');
    expect(issues).toContain('X-Powered-By header present');
    expect(findings.find(f => f.issue === 'Server header discloses version info')?.detail).toBe('Server: nginx/1.18.0');
  });

  it('flags an insecure HTTPS-to-HTTP redirect', () => {
    const findings = analyze([
      responseEvent({
        url: 'https://example.com/old',
        status: 302,
        headers: { location: 'http://example.com/new' },
      }),
    ]);
    expect(findings).toContainEqual(expect.objectContaining({
      severity: 'high',
      issue: 'Insecure redirect (HTTPS → HTTP)',
    }));
  });

  it('flags CORS wildcard origin, and wildcard combined with credentials as high severity', () => {
    const wildcardOnly = analyze([
      responseEvent({
        url: 'https://example.com/api',
        status: 200,
        headers: { ...secureHeaders, 'access-control-allow-origin': '*' },
      }),
    ]);
    expect(wildcardOnly.map(f => f.issue)).toContain('CORS allows any origin');

    const wildcardWithCreds = analyze([
      responseEvent({
        url: 'https://example.com/api',
        status: 200,
        headers: { ...secureHeaders, 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' },
      }),
    ]);
    expect(wildcardWithCreds).toContainEqual(expect.objectContaining({
      severity: 'high',
      issue: 'CORS wildcard combined with credentials',
    }));
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

  it('omits a finding whose rule id is not in enabledRuleIds', () => {
    const ev = responseEvent({ url: 'https://example.com/', status: 200, headers: {} });
    const allEnabled = analyze([ev]);
    expect(allEnabled.map(f => f.ruleId)).toContain('missing-x-frame-options');

    const withoutOne = analyze([ev], new Set(
      allEnabled.map(f => f.ruleId).filter(id => id !== 'missing-x-frame-options')
    ));
    expect(withoutOne.map(f => f.ruleId)).not.toContain('missing-x-frame-options');
    expect(withoutOne.length).toBe(allEnabled.length - 1);
  });
});

describe('computeEnabledRuleIds', () => {
  it('treats an id absent from overrides as enabled', () => {
    const enabled = computeEnabledRuleIds({});
    expect(enabled.has('http-unencrypted')).toBe(true);
    expect(enabled.has('missing-x-frame-options')).toBe(true);
  });

  it('treats undefined overrides as enabling every rule', () => {
    const enabled = computeEnabledRuleIds(undefined);
    expect(enabled.has('cors-acao-wildcard')).toBe(true);
  });

  it('disables only the ids explicitly set to false', () => {
    const enabled = computeEnabledRuleIds({ 'http-unencrypted': false });
    expect(enabled.has('http-unencrypted')).toBe(false);
    expect(enabled.has('missing-x-frame-options')).toBe(true);
  });

  it('treats an id explicitly set to true the same as absent', () => {
    const enabled = computeEnabledRuleIds({ 'http-unencrypted': true });
    expect(enabled.has('http-unencrypted')).toBe(true);
  });
});

describe('computeGroupCheckState (#187 — severity master checkboxes)', () => {
  const rules = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('is "checked" when every rule in the group is enabled', () => {
    expect(computeGroupCheckState(rules, {})).toBe('checked');
    expect(computeGroupCheckState(rules, { a: true, b: true, c: true })).toBe('checked');
  });

  it('is "unchecked" when every rule in the group is disabled', () => {
    expect(computeGroupCheckState(rules, { a: false, b: false, c: false })).toBe('unchecked');
  });

  it('is "indeterminate" for a mix of enabled and disabled rules', () => {
    expect(computeGroupCheckState(rules, { a: false })).toBe('indeterminate');
    expect(computeGroupCheckState(rules, { a: false, b: false })).toBe('indeterminate');
  });

  it('treats a rule missing from overrides as enabled, same as computeEnabledRuleIds', () => {
    expect(computeGroupCheckState(rules, { a: false, b: true })).toBe('indeterminate');
  });

  it('treats undefined overrides as every rule enabled', () => {
    expect(computeGroupCheckState(rules, undefined)).toBe('checked');
  });
});
