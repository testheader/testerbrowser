import type { Rule, RuleAction } from '../rules';

/** A mock rule from a flat set of overrides, for tests that only care about a few fields. */
export function makeMockRule(
  id: string,
  overrides: Partial<Omit<Rule, 'action'>> & { statusCode?: number; body?: string; responseHeaders?: Record<string, string>; cors?: boolean } = {}
): Rule {
  const { statusCode, body, responseHeaders, cors, ...rule } = overrides;
  return {
    id, urlPattern: '*', method: '*', probability: 1, enabled: true, hitCount: 0, lastHitAt: null,
    action: { kind: 'mock', statusCode: statusCode ?? 200, body: body ?? '', responseHeaders: responseHeaders ?? {}, ...(cors !== undefined ? { cors } : {}) },
    ...rule,
  };
}

/** A rule with any action; everything else defaults. */
export function makeRule(id: string, action: RuleAction, overrides: Partial<Omit<Rule, 'action'>> = {}): Rule {
  return { id, urlPattern: '*', method: '*', probability: 1, enabled: true, hitCount: 0, lastHitAt: null, action, ...overrides };
}
