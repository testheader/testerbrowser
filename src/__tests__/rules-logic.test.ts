import {
  ACTIONS, FAIL_MODES, stepCount, hasDetailsStep, supportsDelay, isStepValid, isRuleValid, rewriteChangesSomething,
  buildRule, ruleToFields, defaultFields, describeAction, summarizeRule,
} from '../../renderer/rules-logic.js';

const fields = (over: Record<string, unknown> = {}) => ({ ...defaultFields(), urlPattern: 'https://api.example.com/*', ...over }) as ReturnType<typeof defaultFields>;

describe('Rules stepper (#370)', () => {
  it('only mock and rewrite have a third step; every other action is done after step 2', () => {
    expect(ACTIONS.map(a => [a.kind, stepCount(a.kind)])).toEqual([
      ['mock', 3], ['fail', 2], ['delay', 2], ['hang', 2], ['race', 2], ['rewrite', 3],
    ]);
    expect(hasDetailsStep('mock')).toBe(true);
    expect(hasDetailsStep('race')).toBe(false);
  });

  it('a hang or race gate ignores the shared delay, every other action takes it', () => {
    expect(['mock', 'fail', 'delay', 'rewrite'].every(k => supportsDelay(k as never))).toBe(true);
    expect(supportsDelay('hang')).toBe(false);
    expect(supportsDelay('race')).toBe(false);
  });

  it('step 1 needs a URL pattern and a probability of 1-100', () => {
    expect(isStepValid(1, fields())).toBe(true);
    expect(isStepValid(1, fields({ urlPattern: '  ' }))).toBe(false);
    expect(isStepValid(1, fields({ probability: 0 }))).toBe(false);
    expect(isStepValid(1, fields({ probability: 101 }))).toBe(false);
    expect(isStepValid(1, fields({ probability: '' }))).toBe(false);
    expect(isStepValid(1, fields({ probability: 30 }))).toBe(true);
  });

  it('step 2 validates the action\'s own settings', () => {
    expect(isStepValid(2, fields({ kind: 'delay', delayMs: 0 }))).toBe(false);
    expect(isStepValid(2, fields({ kind: 'delay', delayMs: 1500 }))).toBe(true);
    expect(isStepValid(2, fields({ kind: 'delay', delayMs: 120001 }))).toBe(false);
    expect(isStepValid(2, fields({ kind: 'hang', hangFailAfterSec: 0 }))).toBe(true);
    expect(isStepValid(2, fields({ kind: 'hang', hangFailAfterSec: 601 }))).toBe(false);
    expect(isStepValid(2, fields({ kind: 'race', raceBatch: 1 }))).toBe(false);
    expect(isStepValid(2, fields({ kind: 'race', raceBatch: 51 }))).toBe(false);
    expect(isStepValid(2, fields({ kind: 'race', raceBatch: 3, raceGiveUpSec: 0 }))).toBe(false);
    expect(isStepValid(2, fields({ kind: 'race', raceBatch: 3, raceGiveUpSec: 10 }))).toBe(true);
    expect(isStepValid(2, fields({ kind: 'fail', delayMs: -1 }))).toBe(false);
    expect(isStepValid(2, fields({ kind: 'fail', delayMs: '' }))).toBe(true);
  });

  it('step 3 needs a 100-599 status for a mock, and a rewrite that changes something', () => {
    expect(isStepValid(3, fields({ kind: 'mock', mockStatus: 99 }))).toBe(false);
    expect(isStepValid(3, fields({ kind: 'mock', mockStatus: 600 }))).toBe(false);
    expect(isStepValid(3, fields({ kind: 'mock', mockStatus: 503 }))).toBe(true);
    expect(isStepValid(3, fields({ kind: 'rewrite' }))).toBe(false);
    expect(isStepValid(3, fields({ kind: 'rewrite', rwHeaders: { 'x-a': '1' } }))).toBe(true);
    expect(isStepValid(3, fields({ kind: 'rewrite', rwBodyOn: true, rwBody: '' }))).toBe(true);
  });

  it('a rewrite counts cookies only when a source or an extra cookie is actually set', () => {
    expect(rewriteChangesSomething(fields({ kind: 'rewrite', cookiesOn: true }))).toBe(false);
    expect(rewriteChangesSomething(fields({ kind: 'rewrite', cookiesOn: true, cookieSource: 'persist:a' }))).toBe(true);
    expect(rewriteChangesSomething(fields({ kind: 'rewrite', cookiesOn: true, cookieExtra: { a: '1' } }))).toBe(true);
    expect(rewriteChangesSomething(fields({ kind: 'rewrite', rwMethod: 'PUT' }))).toBe(true);
  });

  it('a rule is saveable only when every step it needs is valid, so a skipped step never blocks it', () => {
    expect(isRuleValid(fields({ kind: 'fail' }))).toBe(true);
    expect(isRuleValid(fields({ kind: 'fail', mockStatus: 'garbage' }))).toBe(true); // step 3 does not apply
    expect(isRuleValid(fields({ kind: 'mock', mockStatus: 'garbage' }))).toBe(false);
    expect(isRuleValid(fields({ urlPattern: '' }))).toBe(false);
  });
});

describe('buildRule', () => {
  it('turns the percent into a fraction and trims the pattern', () => {
    const r = buildRule(fields({ kind: 'fail', failMode: 'offline', probability: 25, urlPattern: ' */x ' }));
    expect(r).toMatchObject({ method: '*', urlPattern: '*/x', probability: 0.25, action: { kind: 'fail', mode: 'offline' } });
  });

  it('builds each action kind', () => {
    expect(buildRule(fields({ kind: 'mock', mockStatus: '201', mockBody: '{}', mockHeaders: { a: 'b' }, mockCors: true })).action)
      .toEqual({ kind: 'mock', statusCode: 201, body: '{}', responseHeaders: { a: 'b' }, cors: true });
    expect(buildRule(fields({ kind: 'delay', delayMs: 1500 }))).toMatchObject({ delayMs: 1500, action: { kind: 'delay' } });
    expect(buildRule(fields({ kind: 'hang', hangFailAfterSec: 30 })).action).toEqual({ kind: 'hang', failAfterMs: 30000 });
    expect(buildRule(fields({ kind: 'hang', hangFailAfterSec: '' })).action).toEqual({ kind: 'hang', failAfterMs: 0 });
    expect(buildRule(fields({ kind: 'race', raceBatch: 4, raceGiveUpSec: 20 })).action).toEqual({ kind: 'race', batchSize: 4, giveUpAfterMs: 20000 });
  });

  it('a hang or race never carries a delay; the others do', () => {
    expect(buildRule(fields({ kind: 'hang', delayMs: 500 })).delayMs).toBe(0);
    expect(buildRule(fields({ kind: 'race', delayMs: 500 })).delayMs).toBe(0);
    expect(buildRule(fields({ kind: 'mock', delayMs: 500 })).delayMs).toBe(500);
  });

  it('a rewrite only includes what was switched on', () => {
    expect(buildRule(fields({ kind: 'rewrite', rwHeaders: { a: '1' } })).action).toEqual({ kind: 'rewrite', headers: { a: '1' } });
    const full = buildRule(fields({
      kind: 'rewrite', rwUrl: ' https://staging.test/x ', rwMethod: 'PUT', rwBodyOn: true, rwBody: '{"a":1}',
      cookiesOn: true, cookieSource: 'persist:other', cookieExtra: { k: 'v' },
    })).action;
    expect(full).toEqual({
      kind: 'rewrite', headers: {}, url: 'https://staging.test/x', method: 'PUT', body: '{"a":1}',
      cookies: { extra: { k: 'v' }, sourcePartition: 'persist:other' },
    });
    // The body checkbox decides, so an empty body still replaces the original.
    expect((buildRule(fields({ kind: 'rewrite', rwBodyOn: true, rwBody: '' })).action as { body?: string }).body).toBe('');
    expect('body' in buildRule(fields({ kind: 'rewrite', rwBodyOn: false, rwBody: 'ignored', rwHeaders: { a: '1' } })).action).toBe(false);
  });

  it('ruleToFields is the inverse of buildRule for every kind', () => {
    const samples = [
      fields({ kind: 'mock', mockStatus: 404, mockBody: 'nope', mockHeaders: { x: 'y' }, mockCors: true, delayMs: 300, probability: 50 }),
      fields({ kind: 'fail', failMode: 'corrupt' }),
      fields({ kind: 'delay', delayMs: 2500 }),
      fields({ kind: 'hang', hangFailAfterSec: 15 }),
      fields({ kind: 'race', raceBatch: 5, raceGiveUpSec: 30 }),
      fields({ kind: 'rewrite', rwUrl: 'https://s.test/', rwMethod: 'PATCH', rwHeaders: { h: 'v' }, rwBodyOn: true, rwBody: 'b', cookiesOn: true, cookieSource: 'persist:z', cookieExtra: { e: '1' } }),
    ];
    for (const f of samples) {
      const rule = { ...buildRule(f), id: 'r', enabled: true };
      expect(buildRule(ruleToFields(rule))).toEqual(buildRule(f));
    }
  });
});

describe('describing rules', () => {
  const rule = (over: Record<string, unknown>) => ({ method: '*', urlPattern: '*', probability: 1, delayMs: 0, ...over });

  it('describes every action in one line', () => {
    expect(describeAction(rule({ action: { kind: 'mock', statusCode: 200 } }))).toBe('Mock 200');
    expect(describeAction(rule({ delayMs: 500, action: { kind: 'mock', statusCode: 200 } }))).toBe('Mock 200, after 500 ms');
    expect(describeAction(rule({ action: { kind: 'fail', mode: 'timeout' } }))).toBe(`Fail: ${FAIL_MODES.find(m => m.value === 'timeout')!.label}`);
    expect(describeAction(rule({ delayMs: 2000, action: { kind: 'delay' } }))).toBe('Delay 2000 ms');
    expect(describeAction(rule({ action: { kind: 'hang', failAfterMs: 30000 } }))).toBe('Hang, fails after 30 s');
    expect(describeAction(rule({ action: { kind: 'hang' } }))).toBe('Hang');
    expect(describeAction(rule({ action: { kind: 'race', batchSize: 3 } }))).toBe('Race: sends 3 together');
  });

  it('a rewrite lists what it changes and names a cookie source, or says it is closed', () => {
    const a = { kind: 'rewrite', url: 'https://s.test', method: 'PUT', headers: { a: '1', b: '2' }, body: '', cookies: { sourcePartition: 'persist:x', extra: {} } };
    expect(describeAction(rule({ action: a }), () => 'Admin')).toBe('Rewrite: URL, method PUT, 2 headers, body, cookies from Admin');
    expect(describeAction(rule({ action: a }), () => undefined)).toContain('cookies from a closed session');
    expect(describeAction(rule({ action: { kind: 'rewrite', headers: { a: '1' } } }))).toBe('Rewrite: 1 header');
  });

  it('summarizes the rule being built, with its method and share of requests', () => {
    expect(summarizeRule(fields({ kind: 'mock', mockStatus: 200, method: 'GET' }))).toBe('Mock 200 on GET `https://api.example.com/*`');
    expect(summarizeRule(fields({ kind: 'fail', failMode: 'offline', probability: 30 }))).toContain('30% of requests');
  });
});
