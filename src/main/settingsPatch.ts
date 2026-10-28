// Pure whitelist-merge for AppSettings patches coming in over IPC (`settings:set`).
// Kept separate from index.ts so it can be unit tested without booting Electron.
//
// Unknown keys are silently dropped and values of the wrong type are ignored
// (the existing value for that key is kept) rather than rejecting the whole
// patch — a single malformed field shouldn't stop the rest of a legitimate
// patch from applying.

import { IDLE_INSTALL_MINUTES_MIN, IDLE_INSTALL_MINUTES_MAX } from './idleInstall';

export interface AppSettings {
  redactSensitiveHeaders: boolean;
  securityRuleOverrides: Record<string, boolean>;
  securityIncludeSubresources: boolean;
  searchEngine: 'google' | 'duckduckgo';
  recordPlaybackColumnWidths: { record: number; saved: number };
  debugMode: boolean;
  recorderMaxEvents: number;
  recordingRetentionDays: number;
  autoOpenDownloadsPanel: boolean;
  autoInstallWhenIdle: boolean;
  allowRealPopups: boolean;
  disabledConsoleTabs: string[];
  idleInstallMinutes: number;
  settingsVersion: number;
}

const SEARCH_ENGINES: ReadonlySet<string> = new Set(['google', 'duckduckgo']);

// Console tabs a user can hide via Settings → Tools. Console and Network
// show the always-on recorded timeline (CDP capture runs regardless of which
// panel is open, per the app's architecture), so they're excluded here and
// can never end up in disabledConsoleTabs.
export const TOGGLEABLE_CONSOLE_TABS = [
  'storage', 'security', 'mock', 'resilience', 'a11y', 'vr', 'diff', 'spoof', 'jira', 'tests',
] as const;
const TOGGLEABLE_CONSOLE_TABS_SET: ReadonlySet<string> = new Set(TOGGLEABLE_CONSOLE_TABS);

// Shared by the JsonStore load path (a hand-edited or stale settings.json)
// and applySettingsPatch() below — filters to known toggleable tab names and
// drops duplicates, same spirit as clampNumberSetting().
export function sanitizeDisabledConsoleTabs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && TOGGLEABLE_CONSOLE_TABS_SET.has(v)))];
}

export const RECORDER_MAX_EVENTS_MIN = 1000;
export const RECORDER_MAX_EVENTS_MAX = 200000;
export const RECORDING_RETENTION_DAYS_MIN = 1;
export const RECORDING_RETENTION_DAYS_MAX = 365;

// #229: shared by the JsonStore load path (a hand-edited or stale
// settings.json) and applySettingsPatch() below (settings:set) — a
// non-number (including NaN) falls back to `fallback` rather than being
// forced into range, since there's no sensible in-range value to clamp it
// to; a number outside [min, max] is clamped, not rejected.
export function clampNumberSetting(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

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

  if (typeof patch.autoOpenDownloadsPanel === 'boolean') {
    next.autoOpenDownloadsPanel = patch.autoOpenDownloadsPanel;
  }

  if (typeof patch.autoInstallWhenIdle === 'boolean') {
    next.autoInstallWhenIdle = patch.autoInstallWhenIdle;
  }

  if (typeof patch.allowRealPopups === 'boolean') {
    next.allowRealPopups = patch.allowRealPopups;
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

  if (typeof patch.securityIncludeSubresources === 'boolean') {
    next.securityIncludeSubresources = patch.securityIncludeSubresources;
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

  if (patch.recorderMaxEvents !== undefined) {
    next.recorderMaxEvents = clampNumberSetting(
      patch.recorderMaxEvents, RECORDER_MAX_EVENTS_MIN, RECORDER_MAX_EVENTS_MAX, current.recorderMaxEvents
    );
  }

  if (patch.recordingRetentionDays !== undefined) {
    next.recordingRetentionDays = clampNumberSetting(
      patch.recordingRetentionDays, RECORDING_RETENTION_DAYS_MIN, RECORDING_RETENTION_DAYS_MAX, current.recordingRetentionDays
    );
  }

  if (Array.isArray(patch.disabledConsoleTabs)) {
    next.disabledConsoleTabs = sanitizeDisabledConsoleTabs(patch.disabledConsoleTabs);
  }

  if (patch.idleInstallMinutes !== undefined) {
    next.idleInstallMinutes = clampNumberSetting(
      patch.idleInstallMinutes, IDLE_INSTALL_MINUTES_MIN, IDLE_INSTALL_MINUTES_MAX, current.idleInstallMinutes
    );
  }

  return next;
}
