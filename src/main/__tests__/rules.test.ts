import {
  pickRule, ruleMatchesRequest, findCorsPreflightRule, applyRulePatch, normalizeRule, moveInArray, reorderArray,
  buildMockFulfillParams, buildMockPreflightParams, buildFailCommand,
  cookieMatchesUrl, buildCookieHeader, buildRewriteParams, validateImportedRules,
  stripSnapshots, clampDelayMs, clampProbability, MAX_SENT_BODY_CHARS, MockAction, RewriteAction, CookieRecord,
} from '../rules';
import { makeMockRule, makeRule } from './ruleFactories';

const req = (method: string, url: string) => ({ method, url });

describe('matching and picking (#370)', () => {
  it('matches by method and URL glob; a missing or * method matches every method', () => {
    expect(ruleMatchesRequest(makeMockRule('a', { urlPattern: '*/api/*', method: 'POST' }), req('POST', 'https://x.test/api/a'))).toBe(true);
    expect(ruleMatchesRequest(makeMockRule('a', { urlPattern: '*/api/*', method: 'POST' }), req('GET', 'https://x.test/api/a'))).toBe(false);
    expect(ruleMatchesRequest(makeMockRule('a', { urlPattern: '*/api/*', method: '*' }), req('DELETE', 'https://x.test/api/a'))).toBe(true);
    expect(ruleMatchesRequest(makeMockRule('a', { urlPattern: '*/api/*', method: '' }), req('PUT', 'https://x.test/api/a'))).toBe(true);
  });

  it('the first enabled match wins — always one winner', () => {
    const rules = [
      makeMockRule('off', { urlPattern: '*', enabled: false }),
      makeMockRule('first', { urlPattern: '*/api/*' }),
      makeRule('second', { kind: 'fail', mode: 'error500' }, { urlPattern: '*/api/*' }),
    ];
    expect(pickRule(rules, req('GET', 'https://x.test/api/a'))?.id).toBe('first');
  });

  it('a failed probability roll skips the rule and the next match gets its own roll', () => {
    const rules = [
      makeRule('flaky', { kind: 'fail', mode: 'error500' }, { probability: 0.3 }),
      makeMockRule('steady'),
    ];
    expect(pickRule(rules, req('GET', 'https://x.test/'), () => 0.2)?.id).toBe('flaky');
    expect(pickRule(rules, req('GET', 'https://x.test/'), () => 0.9)?.id).toBe('steady');
  });

  it('probability applies to every action kind, a mock included, and 1 never rolls', () => {
    const rand = jest.fn(() => 0.99);
    expect(pickRule([makeMockRule('m', { probability: 0.5 })], req('GET', 'https://x.test/'), rand)).toBeNull();
    expect(pickRule([makeMockRule('m', { probability: 1 })], req('GET', 'https://x.test/'), rand)?.id).toBe('m');
    expect(rand).toHaveBeenCalledTimes(1);
  });

  it('a CORS preflight is answered by any enabled mock rule with cors whose URL matches, whatever its method', () => {
    const rules = [
      makeMockRule('nocors', { urlPattern: '*/api/*' }),
      makeRule('fail', { kind: 'fail', mode: 'offline' }, { urlPattern: '*/api/*' }),
      makeMockRule('cors', { urlPattern: '*/api/*', method: 'POST', cors: true }),
    ];
    expect(findCorsPreflightRule(rules, 'https://x.test/api/a')?.id).toBe('cors');
    expect(findCorsPreflightRule(rules, 'https://x.test/other')).toBeNull();
  });
});

describe('editing', () => {
  it('normalizeRule fills defaults and clamps', () => {
    const r = normalizeRule({ id: 'a', urlPattern: '*/x', probability: 7, delayMs: 999_999, action: { kind: 'delay' } });
    expect(r).toMatchObject({ method: '*', probability: 1, delayMs: 120_000, enabled: true, hitCount: 0, lastHitAt: null });
    expect(clampDelayMs('nope')).toBe(0);
    expect(clampProbability(-1)).toBe(0);
  });

  it('a patch never resets identity or hit history, and clamps delay and probability', () => {
    const rule = { ...makeMockRule('keep'), hitCount: 4, lastHitAt: 123 };
    const next = applyRulePatch(rule, { id: 'other', hitCount: 0, lastHitAt: null, urlPattern: '*/new', delayMs: -5, probability: 3 } as never);
    expect(next).toMatchObject({ id: 'keep', hitCount: 4, lastHitAt: 123, urlPattern: '*/new', delayMs: 0, probability: 1 });
  });

  it('an edit keeps the cookie snapshot while the source session is unchanged, and drops it when the source changes', () => {
    const jar: CookieRecord[] = [{ name: 'sid', value: 'v', domain: 'app.test', path: '/' }];
    const rule = makeRule('rw', { kind: 'rewrite', headers: {}, cookies: { sourcePartition: 'persist:a', extra: {}, snapshot: jar } });
    const edited = (cookies: object) => applyRulePatch(rule, { action: { kind: 'rewrite', headers: { x: '1' }, cookies: { extra: {}, ...cookies } } as never });
    expect((edited({ sourcePartition: 'persist:a' }).action as RewriteAction).cookies?.snapshot).toBe(jar);
    expect((edited({ sourcePartition: 'persist:b' }).action as RewriteAction).cookies?.snapshot).toBeUndefined();
  });

  it('stripSnapshots sends the renderer a count instead of the jar', () => {
    const jar: CookieRecord[] = [{ name: 'a', value: '1', domain: 'x.test', path: '/' }, { name: 'b', value: '2', domain: 'x.test', path: '/' }];
    const [out] = stripSnapshots([makeRule('rw', { kind: 'rewrite', headers: {}, cookies: { sourcePartition: 'persist:a', extra: {}, snapshot: jar } })]);
    expect((out.action as RewriteAction).cookies).toEqual({ sourcePartition: 'persist:a', extra: {}, snapshotCount: 2 });
    const plain = makeMockRule('m');
    expect(stripSnapshots([plain])[0]).toBe(plain);
  });

  it('moveInArray swaps with a neighbour and is a no-op at the edges; reorderArray moves to an index', () => {
    expect(moveInArray(['a', 'b', 'c'], 1, 'up')).toEqual(['b', 'a', 'c']);
    expect(moveInArray(['a', 'b', 'c'], 0, 'up')).toEqual(['a', 'b', 'c']);
    expect(moveInArray(['a', 'b', 'c'], 2, 'down')).toEqual(['a', 'b', 'c']);
    const arr = ['a', 'b', 'c', 'd'];
    expect(reorderArray(arr, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(reorderArray(arr, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderArray(arr, 1, 1)).toBe(arr);
    expect(reorderArray(arr, 9, 0)).toBe(arr);
    expect(arr).toEqual(['a', 'b', 'c', 'd']); // never mutated
  });
});

describe('mock responses (#180, #235)', () => {
  const mock = (o: Partial<MockAction> = {}): MockAction =>
    ({ kind: 'mock', statusCode: 200, body: '{"ok":true}', responseHeaders: {}, ...o });

  it('carries headers through as CDP entries with a base64 body, inferring a content type when none is set', () => {
    const p = buildMockFulfillParams(mock({ statusCode: 201, responseHeaders: { 'x-mock': 'yes' } }));
    expect(p.responseCode).toBe(201);
    expect(p.body).toBe(Buffer.from('{"ok":true}').toString('base64'));
    expect(p.responseHeaders).toEqual([{ name: 'x-mock', value: 'yes' }, { name: 'content-type', value: 'application/json; charset=utf-8' }]);
    expect(buildMockFulfillParams(mock({ body: '<p>hi</p>' })).responseHeaders).toContainEqual({ name: 'content-type', value: 'text/html; charset=utf-8' });
  });

  it('strips transport headers that would corrupt the decoded body', () => {
    const names = buildMockFulfillParams(mock({ responseHeaders: { 'Content-Length': '9', 'content-encoding': 'gzip', Connection: 'keep-alive', 'x-keep': '1' } }))
      .responseHeaders.map(h => h.name.toLowerCase());
    expect(names).not.toContain('content-length');
    expect(names).not.toContain('content-encoding');
    expect(names).not.toContain('connection');
    expect(names).toContain('x-keep');
  });

  it('cors echoes the request origin with credentials, falls back to *, and never overrides the rule\'s own header', () => {
    const withOrigin = buildMockFulfillParams(mock({ cors: true }), { headers: { Origin: 'https://app.test' } }).responseHeaders;
    expect(withOrigin).toContainEqual({ name: 'access-control-allow-origin', value: 'https://app.test' });
    expect(withOrigin).toContainEqual({ name: 'access-control-allow-credentials', value: 'true' });
    expect(buildMockFulfillParams(mock({ cors: true })).responseHeaders).toContainEqual({ name: 'access-control-allow-origin', value: '*' });
    const own = buildMockFulfillParams(mock({ cors: true, responseHeaders: { 'Access-Control-Allow-Origin': 'https://mine.test' } })).responseHeaders;
    expect(own.filter(h => h.name.toLowerCase() === 'access-control-allow-origin')).toHaveLength(1);
    expect(buildMockPreflightParams({ headers: { origin: 'https://app.test' } }).responseCode).toBe(204);
  });
});

describe('fail', () => {
  it('maps every mode to a CDP command', () => {
    expect(buildFailCommand('error500', 'r').params).toMatchObject({ responseCode: 500 });
    expect(buildFailCommand('timeout', 'r').params).toMatchObject({ responseCode: 504 });
    expect(buildFailCommand('missing', 'r').params).toMatchObject({ responseCode: 404 });
    expect(buildFailCommand('corrupt', 'r').params).toMatchObject({ responseCode: 200 });
    expect(buildFailCommand('offline', 'r')).toEqual({ command: 'Fetch.failRequest', params: { requestId: 'r', errorReason: 'InternetDisconnected' } });
  });
});

describe('cookies for a rewrite (#370)', () => {
  const c = (o: Partial<CookieRecord>): CookieRecord => ({ name: 'sid', value: 'v', domain: 'app.test', path: '/', ...o });

  it('matches host-only and domain cookies, path prefixes on a boundary, secure and expiry', () => {
    expect(cookieMatchesUrl(c({}), 'https://app.test/x')).toBe(true);
    expect(cookieMatchesUrl(c({}), 'https://sub.app.test/x')).toBe(false); // host-only
    expect(cookieMatchesUrl(c({ domain: '.app.test' }), 'https://sub.app.test/x')).toBe(true);
    expect(cookieMatchesUrl(c({ domain: '.app.test' }), 'https://notapp.test/x')).toBe(false);
    expect(cookieMatchesUrl(c({ path: '/api' }), 'https://app.test/api/users')).toBe(true);
    expect(cookieMatchesUrl(c({ path: '/api' }), 'https://app.test/apiary')).toBe(false);
    expect(cookieMatchesUrl(c({ secure: true }), 'http://app.test/')).toBe(false);
    expect(cookieMatchesUrl(c({ expirationDate: 10 }), 'https://app.test/', 20)).toBe(false);
  });

  it('builds one Cookie header: applicable cookies only, most specific path wins per name, extras override', () => {
    const jar = [
      c({ name: 'sid', value: 'root', path: '/' }),
      c({ name: 'sid', value: 'api', path: '/api' }),
      c({ name: 'theme', value: 'dark' }),
      c({ name: 'other', value: 'x', domain: 'elsewhere.test' }),
    ];
    expect(buildCookieHeader(jar, {}, 'https://app.test/api/me')).toBe('sid=api; theme=dark');
    expect(buildCookieHeader(jar, { theme: 'light', extra: '1' }, 'https://app.test/api/me')).toBe('sid=api; theme=light; extra=1');
    expect(buildCookieHeader([], {}, 'https://app.test/')).toBe('');
  });
});

describe('rewrite params (#370)', () => {
  const base = { url: 'https://api.test/v1/x', method: 'POST', headers: { Authorization: 'Bearer a', 'Content-Length': '2', Cookie: 'own=1' } };
  const rewrite = (o: Partial<RewriteAction> = {}): RewriteAction => ({ kind: 'rewrite', headers: {}, ...o });

  it('with nothing set it changes nothing', () => {
    const { params, sent } = buildRewriteParams(rewrite(), base);
    expect(params.url).toBeUndefined();
    expect(params.method).toBeUndefined();
    expect(params.postData).toBeUndefined();
    expect(sent).toMatchObject({ url: base.url, method: 'POST', headers: base.headers });
  });

  it('sets, replaces and removes headers case-insensitively', () => {
    const { params } = buildRewriteParams(rewrite({ headers: { authorization: 'Bearer b', 'X-New': '1', 'content-type': '' } }), { ...base, headers: { ...base.headers, 'Content-Type': 'text/plain' } });
    const h = Object.fromEntries(params.headers.map(x => [x.name.toLowerCase(), x.value]));
    expect(h.authorization).toBe('Bearer b');
    expect(h['x-new']).toBe('1');
    expect(h['content-type']).toBeUndefined();
  });

  it('"no cookies" is an explicit empty Cookie header, never an omitted one (omitting lets the tab\'s own jar back in)', () => {
    const cookie = (r: ReturnType<typeof buildRewriteParams>) => r.params.headers.find(x => x.name.toLowerCase() === 'cookie');
    expect(cookie(buildRewriteParams(rewrite({ headers: { cookie: '' } }), base))).toEqual({ name: 'Cookie', value: '' });
    expect(cookie(buildRewriteParams(rewrite(), { ...base, headers: {} }, ''))).toEqual({ name: 'Cookie', value: '' });
  });

  it('a body is a full replace and drops the stale content-length; an empty string still replaces', () => {
    const { params, sent } = buildRewriteParams(rewrite({ body: '{"a":1}' }), base);
    expect(params.postData).toBe(Buffer.from('{"a":1}').toString('base64'));
    expect(params.headers.map(x => x.name.toLowerCase())).not.toContain('content-length');
    expect(sent.body).toBe('{"a":1}');
    expect(buildRewriteParams(rewrite({ body: '' }), base).params.postData).toBe('');
  });

  it('the built cookie header replaces the tab\'s own, an empty one sends none, undefined leaves it', () => {
    const cookie = (h?: string) => buildRewriteParams(rewrite(), base, h).params.headers.find(x => x.name.toLowerCase() === 'cookie')?.value;
    expect(cookie('sid=other')).toBe('sid=other');
    expect(cookie('')).toBe('');
    expect(cookie(undefined)).toBe('own=1');
  });

  it('can redirect the URL and change the method; the recorded body is capped', () => {
    const { params, sent } = buildRewriteParams(rewrite({ url: 'https://staging.test/v1/x', method: 'put', body: 'x'.repeat(MAX_SENT_BODY_CHARS + 50) }), base);
    expect(params).toMatchObject({ url: 'https://staging.test/v1/x', method: 'PUT' });
    expect(sent).toMatchObject({ url: 'https://staging.test/v1/x', method: 'PUT' });
    expect(sent.body).toHaveLength(MAX_SENT_BODY_CHARS);
  });
});

describe('validateImportedRules (#264, #370)', () => {
  const file = (rules: unknown[]) => ({ testerBrowserRules: 1, rules });
  const mock = { kind: 'mock', statusCode: 200, body: 'x' };

  it('rejects anything that is not a rules file', () => {
    for (const bad of [null, [], 'x', {}, { testerBrowserRules: 2, rules: [] }, { testerBrowserRules: 1 }, { testerBrowserMocks: 1, rules: [] }]) {
      expect(validateImportedRules(bad).error).toBe('Not a TesterBrowser rules file');
    }
  });

  it('accepts every action kind, defaulting probability and enabled, and drops unknown fields', () => {
    const { rules, skipped } = validateImportedRules(file([
      { method: 'GET', urlPattern: '*/a', action: { ...mock, evil: 1 }, extra: 'dropped' },
      { method: '*', urlPattern: '*/b', action: { kind: 'fail', mode: 'offline' } },
      { method: '*', urlPattern: '*/c', action: { kind: 'delay' }, delayMs: 500 },
      { method: '*', urlPattern: '*/d', action: { kind: 'hang', failAfterMs: 1000 } },
      { method: '*', urlPattern: '*/e', action: { kind: 'race', batchSize: 3 } },
      { method: '*', urlPattern: '*/f', action: { kind: 'rewrite', headers: { a: 'b' }, cookies: { sourcePartition: 'persist:x', extra: { k: 'v' } } }, enabled: false },
    ]));
    expect(skipped).toEqual([]);
    expect(rules).toHaveLength(6);
    expect(rules[0]).toEqual({ method: 'GET', urlPattern: '*/a', probability: 1, delayMs: undefined, enabled: true, action: { kind: 'mock', statusCode: 200, body: 'x', responseHeaders: {}, cors: undefined } });
    expect(rules[5].enabled).toBe(false);
    // A source session means nothing on another machine, so it is never imported.
    expect(rules[5].action).toMatchObject({ kind: 'rewrite', cookies: { extra: { k: 'v' } } });
    expect((rules[5].action as RewriteAction).cookies?.sourcePartition).toBeUndefined();
  });

  it('skips a bad rule with a reason and keeps the rest', () => {
    const { rules, skipped } = validateImportedRules(file([
      'nope',
      { method: 'GET', urlPattern: '', action: mock },
      { method: 'GET', urlPattern: '*', action: { kind: 'mock', statusCode: 99, body: '' } },
      { method: 'GET', urlPattern: '*', action: { kind: 'fail', mode: 'explode' } },
      { method: 'GET', urlPattern: '*', action: { kind: 'wat' } },
      { method: 'GET', urlPattern: '*', probability: 2, action: mock },
      { method: 'GET', urlPattern: '*', action: mock },
    ]));
    expect(rules).toHaveLength(1);
    expect(skipped.map(s => s.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(skipped[2].reason).toMatch(/statusCode/);
    expect(skipped[5].reason).toMatch(/probability/);
  });
});
