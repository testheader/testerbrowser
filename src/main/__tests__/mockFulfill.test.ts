import { buildMockFulfillParams, MockRule } from '../sessionManager';

function makeRule(overrides: Partial<MockRule> = {}): MockRule {
  return {
    id: 'r1',
    urlPattern: '*/api/*',
    method: '*',
    statusCode: 200,
    body: '{"ok":true}',
    responseHeaders: {},
    enabled: true,
    hitCount: 0,
    lastHitAt: null,
    ...overrides,
  };
}

describe('buildMockFulfillParams (#180 — response headers on a mock rule)', () => {
  it('carries responseHeaders through as CDP HeaderEntry pairs, alongside status and base64 body', () => {
    const rule = makeRule({
      statusCode: 201,
      body: '{"mocked":true}',
      responseHeaders: { 'content-type': 'application/json', 'x-mock': 'yes' },
    });

    const params = buildMockFulfillParams(rule);

    expect(params.responseCode).toBe(201);
    expect(params.body).toBe(Buffer.from('{"mocked":true}').toString('base64'));
    expect(params.responseHeaders).toEqual([
      { name: 'content-type', value: 'application/json' },
      { name: 'x-mock', value: 'yes' },
    ]);
  });

  it('still works for a rule with no responseHeaders field at all (pre-#180 rule)', () => {
    const rule = makeRule();
    // Simulate a rule saved before this field existed — plain object without it.
    delete (rule as Partial<MockRule>).responseHeaders;

    const params = buildMockFulfillParams(rule);

    expect(params.responseHeaders).toEqual([]);
    expect(params.responseCode).toBe(200);
    expect(params.body).toBe(Buffer.from('{"ok":true}').toString('base64'));
  });
});
