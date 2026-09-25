import { resilienceRuleMatchesRequest, pickResilienceRule, ResilienceRule } from '../sessionManager';

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

describe('matchesGlob via resilienceRuleMatchesRequest (#219 — "?" is a CDP glob wildcard, not a regex quantifier)', () => {
  it('an exact URL with a query string matches itself', () => {
    const rule = makeRule({ urlPattern: 'https://api.test/items?page=2' });
    expect(resilienceRuleMatchesRequest(rule, { method: 'GET', url: 'https://api.test/items?page=2' })).toBe(true);
  });

  it('"?" matches exactly one character, not zero', () => {
    const rule = makeRule({ urlPattern: 'https://api.test/items?page=2' });
    // Missing the character '?' stands in for — no match.
    expect(resilienceRuleMatchesRequest(rule, { method: 'GET', url: 'https://api.test/itemspage=2' })).toBe(false);
    // A different single character in that position still matches.
    expect(resilienceRuleMatchesRequest(rule, { method: 'GET', url: 'https://api.test/items&page=2' })).toBe(true);
    // Two characters where '?' should match exactly one — no match.
    expect(resilienceRuleMatchesRequest(rule, { method: 'GET', url: 'https://api.test/itemsXXpage=2' })).toBe(false);
  });

  it('"*" still matches zero or more characters, unaffected by the "?" fix', () => {
    const rule = makeRule({ urlPattern: '*/api/*' });
    expect(resilienceRuleMatchesRequest(rule, { method: 'GET', url: 'https://x/api/widgets?a=1&b=2' })).toBe(true);
    expect(resilienceRuleMatchesRequest(rule, { method: 'GET', url: 'https://x/api/' })).toBe(true);
  });

  it('other regex metacharacters — "(", "+", "$" — match literally', () => {
    const rule = makeRule({ urlPattern: 'https://x/api/widgets(v2)+$' });
    expect(resilienceRuleMatchesRequest(rule, { method: 'GET', url: 'https://x/api/widgets(v2)+$' })).toBe(true);
    // Not treated as a regex group/quantifier/anchor.
    expect(resilienceRuleMatchesRequest(rule, { method: 'GET', url: 'https://x/api/widgetsv2v2' })).toBe(false);
  });
});

describe('pickResilienceRule (#236 — fall-through rule evaluation)', () => {
  const req = { method: 'GET', url: 'https://x/api/widgets' };

  it('a first rule whose roll fails falls through to a second rule that fires', () => {
    const failThenSucceed = { next: 0, values: [0.9, 0.1] } as { next: number; values: number[] };
    const rand = () => failThenSucceed.values[failThenSucceed.next++];
    const first = makeRule({ id: 'first', probability: 0.5 });
    const second = makeRule({ id: 'second', probability: 0.5 });
    expect(pickResilienceRule([first, second], req, rand)).toBe(second);
  });

  it('returns null when every matching rule\'s roll fails', () => {
    const rand = () => 0.99;
    const rules = [makeRule({ id: 'a', probability: 0.5 }), makeRule({ id: 'b', probability: 0.5 })];
    expect(pickResilienceRule(rules, req, rand)).toBeNull();
  });

  it('skips disabled rules entirely, regardless of their roll', () => {
    const rand = () => 0; // would always "win" if it were even rolled
    const disabled = makeRule({ id: 'disabled', enabled: false, probability: 1 });
    const enabled = makeRule({ id: 'enabled', probability: 1 });
    expect(pickResilienceRule([disabled, enabled], req, rand)).toBe(enabled);
  });

  it('respects list order — an earlier rule that also would have fired wins over a later one', () => {
    const rand = () => 0; // both would fire
    const first = makeRule({ id: 'first', probability: 1 });
    const second = makeRule({ id: 'second', probability: 1 });
    expect(pickResilienceRule([second, first], req, rand)).toBe(second);
  });

  it('a non-matching rule (method or URL) never gets a roll at all', () => {
    let rolled = false;
    const rand = () => { rolled = true; return 0; };
    const nonMatching = makeRule({ id: 'nope', method: 'POST', probability: 1 });
    expect(pickResilienceRule([nonMatching], req, rand)).toBeNull();
    expect(rolled).toBe(false);
  });
});
