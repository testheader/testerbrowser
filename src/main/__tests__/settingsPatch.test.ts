import { applySettingsPatch, AppSettings, clampNumberSetting } from '../settingsPatch';

const BASE: AppSettings = {
  redactSensitiveHeaders: false,
  securityRuleOverrides: { ruleA: true },
  securityIncludeSubresources: false,
  searchEngine: 'google',
  recordPlaybackColumnWidths: { record: 220, saved: 420 },
  debugMode: false,
  recorderMaxEvents: 20000,
  recordingRetentionDays: 30,
  autoOpenDownloadsPanel: false,
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

  it('applies autoOpenDownloadsPanel and ignores a wrong-typed value (#247)', () => {
    expect(applySettingsPatch(BASE, { autoOpenDownloadsPanel: true }).autoOpenDownloadsPanel).toBe(true);
    expect(applySettingsPatch(BASE, { autoOpenDownloadsPanel: 'yes' }).autoOpenDownloadsPanel).toBe(false);
  });

  it('applies securityIncludeSubresources and ignores a wrong-typed value (#240)', () => {
    expect(applySettingsPatch(BASE, { securityIncludeSubresources: true }).securityIncludeSubresources).toBe(true);
    expect(applySettingsPatch(BASE, { securityIncludeSubresources: 'yes' }).securityIncludeSubresources).toBe(false);
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

  // #229
  describe('recorderMaxEvents / recordingRetentionDays', () => {
    it('accepts an in-range value for both', () => {
      const result = applySettingsPatch(BASE, { recorderMaxEvents: 50000, recordingRetentionDays: 14 });
      expect(result.recorderMaxEvents).toBe(50000);
      expect(result.recordingRetentionDays).toBe(14);
    });

    it('clamps recorderMaxEvents below the 1,000 floor up to it', () => {
      expect(applySettingsPatch(BASE, { recorderMaxEvents: 50 }).recorderMaxEvents).toBe(1000);
    });

    it('clamps recorderMaxEvents above the 200,000 cap down to it', () => {
      expect(applySettingsPatch(BASE, { recorderMaxEvents: 999_999 }).recorderMaxEvents).toBe(200000);
    });

    it('clamps recordingRetentionDays below the 1-day floor up to it', () => {
      expect(applySettingsPatch(BASE, { recordingRetentionDays: 0 }).recordingRetentionDays).toBe(1);
    });

    it('clamps recordingRetentionDays above the 365-day cap down to it', () => {
      expect(applySettingsPatch(BASE, { recordingRetentionDays: 1000 }).recordingRetentionDays).toBe(365);
    });

    it('falls back to the current value for a non-number (including NaN)', () => {
      expect(applySettingsPatch(BASE, { recorderMaxEvents: 'lots' }).recorderMaxEvents).toBe(BASE.recorderMaxEvents);
      expect(applySettingsPatch(BASE, { recorderMaxEvents: NaN }).recorderMaxEvents).toBe(BASE.recorderMaxEvents);
      expect(applySettingsPatch(BASE, { recordingRetentionDays: null }).recordingRetentionDays).toBe(BASE.recordingRetentionDays);
    });

    it('leaves the current value alone when the key is absent from the patch', () => {
      const withCustom = { ...BASE, recorderMaxEvents: 75000 };
      expect(applySettingsPatch(withCustom, { debugMode: true }).recorderMaxEvents).toBe(75000);
    });
  });
});

describe('clampNumberSetting (#229)', () => {
  it('passes an in-range value through unchanged', () => {
    expect(clampNumberSetting(500, 100, 1000, 200)).toBe(500);
  });

  it('clamps a below-range value up to the minimum', () => {
    expect(clampNumberSetting(1, 100, 1000, 200)).toBe(100);
  });

  it('clamps an above-range value down to the maximum', () => {
    expect(clampNumberSetting(9999, 100, 1000, 200)).toBe(1000);
  });

  it('falls back to the given fallback for a non-number', () => {
    expect(clampNumberSetting('nope', 100, 1000, 200)).toBe(200);
    expect(clampNumberSetting(undefined, 100, 1000, 200)).toBe(200);
    expect(clampNumberSetting(null, 100, 1000, 200)).toBe(200);
  });

  it('falls back to the given fallback for NaN and non-finite numbers', () => {
    expect(clampNumberSetting(NaN, 100, 1000, 200)).toBe(200);
    expect(clampNumberSetting(Infinity, 100, 1000, 200)).toBe(200);
    expect(clampNumberSetting(-Infinity, 100, 1000, 200)).toBe(200);
  });

  it('rounds a fractional in-range value', () => {
    expect(clampNumberSetting(500.6, 100, 1000, 200)).toBe(501);
  });
});
