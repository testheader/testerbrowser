// settings.json schema version. Bump when a default changes for existing users.
//   1 (or absent): the file predates versioning.
//   2: idle install (#259) is on by default. Pre-v2 files are migrated once on
//      load, so the new default reaches existing users. Later saves keep the
//      user's own choice, including turning it off.
export const SETTINGS_VERSION = 2;

// True for a settings.json that predates the current SETTINGS_VERSION.
// Non-object data is left alone: JsonStore's normalizer only spreads objects.
export function isPreV2Settings(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  return (raw as { settingsVersion?: unknown }).settingsVersion !== SETTINGS_VERSION;
}
