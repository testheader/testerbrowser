// #271: device/viewport, touch and media-query emulation — pure preset/
// conversion logic, kept Electron-free so it's unit-testable without a
// debugger session (same reasoning as networkConditions.ts). The device
// preset *table* itself lives in renderer/emulation.js, not here — the panel
// resolves a picked preset to concrete width/height/deviceScaleFactor/mobile
// numbers before sending them to setEmulation, so the main process never
// needs to know preset names, only whichever renderer already picked.

export interface DeviceMetrics {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

export type ColorScheme = 'light' | 'dark';
export type ReducedMotion = 'reduce';

// Builds Emulation.setEmulatedMedia's `features` array from the two
// independent preference fields. "System" for either is represented by the
// field being absent/undefined here, which simply omits that feature from
// the array — CDP then leaves Chromium's own OS-derived default in effect
// for it, rather than this needing to look up or restate that default.
export function buildMediaFeatures(
  colorScheme?: ColorScheme,
  reducedMotion?: ReducedMotion
): { name: string; value: string }[] {
  const features: { name: string; value: string }[] = [];
  if (colorScheme) features.push({ name: 'prefers-color-scheme', value: colorScheme });
  if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: reducedMotion });
  return features;
}
