import { isMockStepValid, summarizeMockRule } from '../../renderer/mock-logic.js';

describe('isMockStepValid', () => {
  it('step 1 needs a non-blank URL pattern', () => {
    expect(isMockStepValid(1, { urlPattern: '', status: '200' })).toBe(false);
    expect(isMockStepValid(1, { urlPattern: '  ', status: '200' })).toBe(false);
    expect(isMockStepValid(1, { urlPattern: '*/api', status: '' })).toBe(true);
  });
  it('step 2 needs an integer status 100-599', () => {
    for (const s of ['99', '600', '', 'abc', '200.5']) expect(isMockStepValid(2, { urlPattern: 'x', status: s })).toBe(false);
    for (const s of ['100', '200', '599', 404]) expect(isMockStepValid(2, { urlPattern: 'x', status: s })).toBe(true);
  });
});

describe('summarizeMockRule', () => {
  it('includes the method when specific', () => {
    expect(summarizeMockRule({ status: 200, method: 'GET', urlPattern: 'https://api.example.com/*' }))
      .toBe('200 on GET https://api.example.com/*');
  });
  it('omits the method for any method and falls back to * for a blank pattern', () => {
    expect(summarizeMockRule({ status: '404', method: '*', urlPattern: '/a' })).toBe('404 on /a');
    expect(summarizeMockRule({ status: 200, urlPattern: ' ' })).toBe('200 on *');
  });
});
