import { stripRedactedHeaders } from '../../renderer/utils.js';

describe('stripRedactedHeaders (#233)', () => {
  it('drops any header whose value is exactly [REDACTED]', () => {
    const result = stripRedactedHeaders({ Authorization: '[REDACTED]', Accept: 'application/json' });
    expect(result).toEqual({ Accept: 'application/json' });
  });

  it('leaves headers untouched when nothing is redacted', () => {
    const headers = { Accept: 'application/json', 'X-Custom': 'value' };
    expect(stripRedactedHeaders(headers)).toEqual(headers);
  });

  it('does not treat a value merely containing the word as redacted', () => {
    const result = stripRedactedHeaders({ 'X-Note': 'not [REDACTED] really' });
    expect(result).toEqual({ 'X-Note': 'not [REDACTED] really' });
  });

  it('returns an empty object for undefined or null input', () => {
    expect(stripRedactedHeaders(undefined)).toEqual({});
    expect(stripRedactedHeaders(null)).toEqual({});
  });
});
