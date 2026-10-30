import { isResStepValid, summarizeResRule } from '../../renderer/resilience-logic.js';

describe('isResStepValid', () => {
  it('step 1 is always valid', () => {
    expect(isResStepValid(1, { urlPattern: '', probability: '' })).toBe(true);
  });
  it('step 2 needs a non-blank URL pattern', () => {
    expect(isResStepValid(2, { urlPattern: '  ', probability: '100' })).toBe(false);
    expect(isResStepValid(2, { urlPattern: '*ads*', probability: '100' })).toBe(true);
  });
  it('step 3 needs an integer probability 1-100', () => {
    for (const p of ['0', '101', '', 'abc', '1.5']) expect(isResStepValid(3, { urlPattern: 'x', probability: p })).toBe(false);
    for (const p of ['1', '50', '100', 100]) expect(isResStepValid(3, { urlPattern: 'x', probability: p })).toBe(true);
  });
});

describe('summarizeResRule', () => {
  it('formats type, pattern and probability', () => {
    expect(summarizeResRule({ typeLabel: '500 error', urlPattern: '*ads*', probability: '100' }))
      .toBe('500 error on `*ads*`, 100%');
  });
  it('includes method, delay and release when relevant', () => {
    expect(summarizeResRule({ typeLabel: 'Latency', type: 'latency', urlPattern: '/a', method: 'POST', probability: 50, latencyMs: 2000 }))
      .toBe('Latency on POST `/a`, 50%, 2000 ms');
    expect(summarizeResRule({ typeLabel: 'Hang', type: 'hang', urlPattern: '/a', probability: 100, releaseSec: 5 }))
      .toBe('Hang on `/a`, 100%, released after 5 s');
  });
  it('falls back to * for a blank pattern', () => {
    expect(summarizeResRule({ typeLabel: '404', urlPattern: ' ', probability: 100 })).toBe('404 on `*`, 100%');
  });
});
