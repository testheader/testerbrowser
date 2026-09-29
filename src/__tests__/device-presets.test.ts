import { DEVICE_PRESETS } from '../../renderer/emulation.js';

describe('DEVICE_PRESETS (#271)', () => {
  it('includes every preset the ticket names', () => {
    expect(Object.keys(DEVICE_PRESETS)).toEqual([
      'iPhone 14', 'iPhone SE', 'Pixel 7', 'iPad', 'Galaxy S21', 'Desktop 1080p', 'Desktop 1440p',
    ]);
  });

  it('every preset has positive integer width/height, a positive deviceScaleFactor and a boolean mobile flag', () => {
    for (const [name, preset] of Object.entries(DEVICE_PRESETS)) {
      expect(Number.isInteger(preset.width)).toBe(true);
      expect(preset.width).toBeGreaterThan(0);
      expect(Number.isInteger(preset.height)).toBe(true);
      expect(preset.height).toBeGreaterThan(0);
      expect(preset.deviceScaleFactor).toBeGreaterThan(0);
      expect(typeof preset.mobile).toBe('boolean');
      // Sanity: a preset's dimensions shouldn't collide with another's under
      // the same mobile flag — that would make findDevicePresetName() (the
      // renderer's reverse lookup) pick whichever happens to iterate first.
      for (const [otherName, other] of Object.entries(DEVICE_PRESETS)) {
        if (otherName === name) continue;
        const collides = other.width === preset.width && other.height === preset.height
          && other.deviceScaleFactor === preset.deviceScaleFactor && other.mobile === preset.mobile;
        expect(collides).toBe(false);
      }
    }
  });

  it('the desktop presets are not flagged mobile, and the phone/tablet presets are', () => {
    expect(DEVICE_PRESETS['Desktop 1080p'].mobile).toBe(false);
    expect(DEVICE_PRESETS['Desktop 1440p'].mobile).toBe(false);
    expect(DEVICE_PRESETS['iPhone 14'].mobile).toBe(true);
    expect(DEVICE_PRESETS['iPad'].mobile).toBe(true);
  });
});
