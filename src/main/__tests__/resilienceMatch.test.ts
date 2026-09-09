import { resilienceRuleMatchesRequest, ResilienceRule } from '../sessionManager';

function makeRule(overrides: Partial<ResilienceRule> = {}): ResilienceRule {
  return {
    id: 'r1',
    type: 'error500',
    urlPattern: '*/api/*',
    method: '*',
    probability: 1,
    latencyMs: 2000,
    enabled: true,
    hitCount: 0,
    lastHitAt: null,
    ...overrides,
  };
}

describe('resilienceRuleMatchesRequest (#181 — method scoping)', () => {
  it('a rule scoped to POST matches a POST request', () => {
    const rule = makeRule({ method: 'POST' });
    expect(resilienceRuleMatchesRequest(rule, { method: 'POST', url: 'https://x/api/widgets' })).toBe(true);
  });

  it('a rule scoped to POST does not match a GET request to the same URL', () => {
    const rule = makeRule({ method: 'POST' });
    expect(resilienceRuleMatchesRequest(rule, { method: 'GET', url: 'https://x/api/widgets' })).toBe(false);
  });

  it("a rule with method '*' matches every method", () => {
    const rule = makeRule({ method: '*' });
    expect(resilienceRuleMatchesRequest(rule, { method: 'GET',  url: 'https://x/api/widgets' })).toBe(true);
    expect(resilienceRuleMatchesRequest(rule, { method: 'POST', url: 'https://x/api/widgets' })).toBe(true);
  });

  it('a rule saved before the method field existed (undefined) still matches every method', () => {
    const rule = makeRule();
    delete (rule as Partial<ResilienceRule>).method;
    expect(resilienceRuleMatchesRequest(rule, { method: 'GET',  url: 'https://x/api/widgets' })).toBe(true);
    expect(resilienceRuleMatchesRequest(rule, { method: 'POST', url: 'https://x/api/widgets' })).toBe(true);
  });

  it('still respects the URL pattern regardless of method scoping', () => {
    const rule = makeRule({ method: 'GET', urlPattern: '*/api/widgets' });
    expect(resilienceRuleMatchesRequest(rule, { method: 'GET', url: 'https://x/api/other' })).toBe(false);
  });
});
