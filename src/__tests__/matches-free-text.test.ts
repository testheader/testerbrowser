import { matchesFreeText } from '../../renderer/utils.js';

describe('matchesFreeText', () => {
  it('returns true for an empty filter', () => {
    expect(matchesFreeText('https://example.com/api/users', '')).toBe(true);
    expect(matchesFreeText('https://example.com/api/users', '   ')).toBe(true);
  });

  it('keeps only text containing a positive term', () => {
    expect(matchesFreeText('https://example.com/api/users', 'api')).toBe(true);
    expect(matchesFreeText('https://example.com/static/logo.png', 'api')).toBe(false);
  });

  it('excludes text containing a negative (-term) term', () => {
    expect(matchesFreeText('https://analytics.example.com/beacon', '-analytics')).toBe(false);
    expect(matchesFreeText('https://example.com/api/users', '-analytics')).toBe(true);
  });

  it('combines positive and negative terms: all positives must match, any negative excludes', () => {
    const filter = 'api -analytics';
    expect(matchesFreeText('https://example.com/api/users', filter)).toBe(true);
    expect(matchesFreeText('https://analytics.example.com/api/beacon', filter)).toBe(false);
    expect(matchesFreeText('https://example.com/static/logo.png', filter)).toBe(false);
  });

  it('treats a lone "-" as a literal character, not a negation', () => {
    expect(matchesFreeText('https://example.com/api-users', '-')).toBe(true);
    expect(matchesFreeText('https://example.com/apiusers', '-')).toBe(false);
  });

  it('is case-insensitive for both the text and the terms', () => {
    expect(matchesFreeText('https://Example.com/API/Users', 'api')).toBe(true);
    expect(matchesFreeText('https://Example.com/API/Users', 'API')).toBe(true);
    expect(matchesFreeText('https://ANALYTICS.example.com', '-analytics')).toBe(false);
    expect(matchesFreeText('https://ANALYTICS.example.com', '-ANALYTICS')).toBe(false);
  });
});
