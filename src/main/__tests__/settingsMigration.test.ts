import { isPreV2Settings, SETTINGS_VERSION } from '../settingsMigration';

describe('settings schema migration', () => {
  it('is at version 2', () => {
    expect(SETTINGS_VERSION).toBe(2);
  });

  it('treats a file with no version as pre-v2', () => {
    expect(isPreV2Settings({ debugMode: true })).toBe(true);
  });

  it('treats an older version as pre-v2', () => {
    expect(isPreV2Settings({ settingsVersion: 1 })).toBe(true);
  });

  it('leaves a current-version file alone', () => {
    expect(isPreV2Settings({ settingsVersion: SETTINGS_VERSION })).toBe(false);
  });

  it('ignores non-object data', () => {
    expect(isPreV2Settings(null)).toBe(false);
    expect(isPreV2Settings('oops')).toBe(false);
  });
});
