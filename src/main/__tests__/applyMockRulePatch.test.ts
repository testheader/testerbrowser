import { applyMockRulePatch, MockRule } from '../sessionManager';

function makeRule(overrides: Partial<MockRule> = {}): MockRule {
  return {
    id: 'r1',
    urlPattern: '*/api/*',
    method: '*',
    statusCode: 200,
    body: '{"ok":true}',
    responseHeaders: {},
    enabled: true,
    hitCount: 3,
    lastHitAt: 1700000000000,
    ...overrides,
  };
}

describe('applyMockRulePatch (#182 — editing a mock rule in place)', () => {
  it('merges the patch onto the rule', () => {
    const rule = makeRule();
    const patched = applyMockRulePatch(rule, { statusCode: 503, urlPattern: '*/api/v2/*' });

    expect(patched.statusCode).toBe(503);
    expect(patched.urlPattern).toBe('*/api/v2/*');
    expect(patched.method).toBe('*'); // untouched fields survive
  });

  it('preserves id, hitCount and lastHitAt even if the patch tries to change them', () => {
    const rule = makeRule({ id: 'r1', hitCount: 5, lastHitAt: 1700000000000 });
    const patched = applyMockRulePatch(rule, {
      id: 'someone-elses-id',
      hitCount: 999,
      lastHitAt: 0,
      statusCode: 503,
    } as Partial<MockRule>);

    expect(patched.id).toBe('r1');
    expect(patched.hitCount).toBe(5);
    expect(patched.lastHitAt).toBe(1700000000000);
    expect(patched.statusCode).toBe(503);
  });

  it('does not mutate the original rule object', () => {
    const rule = makeRule();
    const patched = applyMockRulePatch(rule, { statusCode: 503 });

    expect(rule.statusCode).toBe(200);
    expect(patched).not.toBe(rule);
  });
});
