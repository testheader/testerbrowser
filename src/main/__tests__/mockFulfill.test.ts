import { buildMockFulfillParams, buildMockPreflightParams, MockRule } from '../sessionManager';

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

    // #235: a rule with no explicit Content-Type gets one inferred from the
    // body — this rule's body is valid JSON.
    expect(params.responseHeaders).toEqual([{ name: 'content-type', value: 'application/json; charset=utf-8' }]);
    expect(params.responseCode).toBe(200);
    expect(params.body).toBe(Buffer.from('{"ok":true}').toString('base64'));
  });
});

describe('buildMockFulfillParams (#235 — encoding headers, default Content-Type, CORS)', () => {
  it('strips content-length/content-encoding/transfer-encoding/connection, case-insensitively', () => {
    const rule = makeRule({
      responseHeaders: {
        'Content-Length': '42',
        'content-encoding': 'gzip',
        'Transfer-Encoding': 'chunked',
        Connection: 'keep-alive',
        'x-kept': 'yes',
        'content-type': 'text/plain',
      },
    });

    const params = buildMockFulfillParams(rule);

    expect(params.responseHeaders).toEqual([
      { name: 'x-kept', value: 'yes' },
      { name: 'content-type', value: 'text/plain' },
    ]);
  });

  it('infers application/json for a JSON body', () => {
    const rule = makeRule({ body: '{"a":1}', responseHeaders: {} });
    const params = buildMockFulfillParams(rule);
    expect(params.responseHeaders).toContainEqual({ name: 'content-type', value: 'application/json; charset=utf-8' });
  });

  it('infers text/html for a body that looks like markup', () => {
    const rule = makeRule({ body: '<html><body>hi</body></html>', responseHeaders: {} });
    const params = buildMockFulfillParams(rule);
    expect(params.responseHeaders).toContainEqual({ name: 'content-type', value: 'text/html; charset=utf-8' });
  });

  it('infers text/plain for anything else', () => {
    const rule = makeRule({ body: 'just some text', responseHeaders: {} });
    const params = buildMockFulfillParams(rule);
    expect(params.responseHeaders).toContainEqual({ name: 'content-type', value: 'text/plain; charset=utf-8' });
  });

  it('never overrides an explicit Content-Type', () => {
    const rule = makeRule({ body: '{"a":1}', responseHeaders: { 'Content-Type': 'application/xml' } });
    const params = buildMockFulfillParams(rule);
    expect(params.responseHeaders).toEqual([{ name: 'Content-Type', value: 'application/xml' }]);
  });

  it('CORS on with an Origin header echoes it and adds credentials + allow-headers', () => {
    const rule = makeRule({ body: 'ok', responseHeaders: { 'content-type': 'text/plain' }, cors: true });
    const params = buildMockFulfillParams(rule, { headers: { Origin: 'https://example.com' } });
    expect(params.responseHeaders).toEqual(expect.arrayContaining([
      { name: 'access-control-allow-origin', value: 'https://example.com' },
      { name: 'access-control-allow-credentials', value: 'true' },
      { name: 'access-control-allow-headers', value: '*' },
    ]));
  });

  it('CORS on without an Origin header gives a wildcard and no credentials header', () => {
    const rule = makeRule({ body: 'ok', responseHeaders: { 'content-type': 'text/plain' }, cors: true });
    const params = buildMockFulfillParams(rule);
    expect(params.responseHeaders).toContainEqual({ name: 'access-control-allow-origin', value: '*' });
    expect(params.responseHeaders).not.toContainEqual(expect.objectContaining({ name: 'access-control-allow-credentials' }));
  });

  it('does not add CORS headers the rule already sets itself', () => {
    const rule = makeRule({
      body: 'ok',
      responseHeaders: { 'content-type': 'text/plain', 'access-control-allow-origin': 'https://custom.example' },
      cors: true,
    });
    const params = buildMockFulfillParams(rule, { headers: { Origin: 'https://example.com' } });
    const origins = params.responseHeaders.filter(h => h.name === 'access-control-allow-origin');
    expect(origins).toEqual([{ name: 'access-control-allow-origin', value: 'https://custom.example' }]);
  });
});

describe('buildMockPreflightParams (#235 — CORS OPTIONS preflight)', () => {
  it('answers 204 with the CORS headers, echoing Origin when present', () => {
    const params = buildMockPreflightParams({ headers: { Origin: 'https://example.com' } });
    expect(params.responseCode).toBe(204);
    expect(params.responseHeaders).toEqual(expect.arrayContaining([
      { name: 'access-control-allow-origin', value: 'https://example.com' },
      { name: 'access-control-allow-credentials', value: 'true' },
      { name: 'access-control-allow-headers', value: '*' },
    ]));
  });

  it('falls back to a wildcard origin with no credentials header when there is no Origin', () => {
    const params = buildMockPreflightParams();
    expect(params.responseCode).toBe(204);
    expect(params.responseHeaders).toContainEqual({ name: 'access-control-allow-origin', value: '*' });
    expect(params.responseHeaders).not.toContainEqual(expect.objectContaining({ name: 'access-control-allow-credentials' }));
  });
});
