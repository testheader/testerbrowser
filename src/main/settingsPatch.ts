// Pure whitelist-merge for AppSettings patches coming in over IPC (`settings:set`).
// Kept separate from index.ts so it can be unit tested without booting Electron.
//
// Unknown keys are silently dropped and values of the wrong type are ignored
// (the existing value for that key is kept) rather than rejecting the whole
// patch — a single malformed field shouldn't stop the rest of a legitimate
// patch from applying.

export interface AppSettings {
  redactSensitiveHeaders: boolean;
  securityRuleOverrides: Record<string, boolean>;
  searchEngine: 'google' | 'duckduckgo';
  recordPlaybackColumnWidths: { record: number; saved: number };
  debugMode: boolean;
}

const SEARCH_ENGINES: ReadonlySet<string> = new Set(['google', 'duckduckgo']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function applySettingsPatch(current: AppSettings, patch: unknown): AppSettings {
  if (!isPlainObject(patch)) return current;
  const next: AppSettings = { ...current };

  if (typeof patch.redactSensitiveHeaders === 'boolean') {
    next.redactSensitiveHeaders = patch.redactSensitiveHeaders;
  }

  if (typeof patch.debugMode === 'boolean') {
    next.debugMode = patch.debugMode;
  }

  if (typeof patch.searchEngine === 'string' && SEARCH_ENGINES.has(patch.searchEngine)) {
    next.searchEngine = patch.searchEngine as AppSettings['searchEngine'];
  }

  if (isPlainObject(patch.securityRuleOverrides)) {
    const overrides: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(patch.securityRuleOverrides)) {
      if (typeof value === 'boolean') overrides[key] = value;
    }
    next.securityRuleOverrides = overrides;
  }

  if (isPlainObject(patch.recordPlaybackColumnWidths)) {
    const w = patch.recordPlaybackColumnWidths;
    next.recordPlaybackColumnWidths = {
      record: typeof w.record === 'number' && Number.isFinite(w.record)
        ? w.record : current.recordPlaybackColumnWidths.record,
      saved: typeof w.saved === 'number' && Number.isFinite(w.saved)
        ? w.saved : current.recordPlaybackColumnWidths.saved,
    };
  }

  return next;
}
