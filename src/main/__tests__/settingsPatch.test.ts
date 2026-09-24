import { applySettingsPatch, AppSettings } from '../settingsPatch';

const BASE: AppSettings = {
  redactSensitiveHeaders: false,
  securityRuleOverrides: { ruleA: true },
  searchEngine: 'google',
  recordPlaybackColumnWidths: { record: 220, saved: 420 },
  debugMode: false,
};

describe('applySettingsPatch (#217 — settings:set whitelist)', () => {
  it('applies a valid patch across multiple known keys', () => {
    const result = applySettingsPatch(BASE, {
      redactSensitiveHeaders: true,
      debugMode: true,
      searchEngine: 'duckduckgo',
    });
    expect(result).toEqual({
      ...BASE,
      redactSensitiveHeaders: true,
      debugMode: true,
      searchEngine: 'duckduckgo',
    });
  });

  it('drops unknown keys', () => {
    const result = applySettingsPatch(BASE, { totallyUnknownKey: 'x', redactSensitiveHeaders: true });
    expect(result).toEqual({ ...BASE, redactSensitiveHeaders: true });
    expect(result).not.toHaveProperty('totallyUnknownKey');
  });

  it('ignores wrong-typed values and keeps the current value', () => {
    const result = applySettingsPatch(BASE, {
      redactSensitiveHeaders: 'yes', // wrong type — should be ignored
      debugMode: 1, // wrong type
      searchEngine: 'bing', // not in the union
    });
    expect(result).toEqual(BASE);
  });

  it('replaces securityRuleOverrides wholesale, filtering non-boolean entries', () => {
    const result = applySettingsPatch(BASE, {
      securityRuleOverrides: { ruleB: false, ruleC: 'nope', ruleD: true },
    });
    expect(result.securityRuleOverrides).toEqual({ ruleB: false, ruleD: true });
  });

  it('ignores a non-object securityRuleOverrides', () => {
    const result = applySettingsPatch(BASE, { securityRuleOverrides: 'nope' });
    expect(result.securityRuleOverrides).toEqual(BASE.securityRuleOverrides);
  });

  it('accepts valid recordPlaybackColumnWidths and falls back per-field on bad values', () => {
    const result = applySettingsPatch(BASE, {
      recordPlaybackColumnWidths: { record: 300, saved: 'wide' },
    });
    expect(result.recordPlaybackColumnWidths).toEqual({ record: 300, saved: 420 });
  });

  it('returns the current settings unchanged for a non-object patch', () => {
    expect(applySettingsPatch(BASE, null)).toEqual(BASE);
    expect(applySettingsPatch(BASE, 'nope')).toEqual(BASE);
    expect(applySettingsPatch(BASE, [1, 2, 3])).toEqual(BASE);
  });

  it('does not mutate the input settings object', () => {
    const copy = { ...BASE, securityRuleOverrides: { ...BASE.securityRuleOverrides } };
    applySettingsPatch(BASE, { redactSensitiveHeaders: true, securityRuleOverrides: { x: true } });
    expect(BASE).toEqual(copy);
  });
});
