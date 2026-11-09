import type { EmulationOverrides } from './emulationManager';
import type { MockRule } from './mockManager';

/**
 * open-sessions.json (#367). One entry per window under `windows`, each with
 * that window's persistent tabs in tab-strip order. Notes (keyed by session
 * id), emulation overrides and mock rules (both keyed by partition) are
 * shared by every window, so they sit at the top level — a partition used by
 * tabs in two windows has one entry, not two that could disagree.
 *
 * The flat top-level `sessions` array (every window's tabs, in window order)
 * is still written so an older build reading this file restores all tabs into
 * its single window instead of none. Files written before multi-window
 * (`{ sessions, notes, emulation, mocks }` with no `windows`) read back as
 * one window.
 */
export interface SavedSession {
  id?: string;
  name: string;
  partition: string;
  url?: string | null;
  color?: string;
  pinned?: boolean;
}

/** What one window's SessionManager contributes when saving. */
export interface WindowSaveState {
  sessions: SavedSession[];
  notes: Record<string, string>;
  emulation: Record<string, EmulationOverrides>;
  mocks: Record<string, MockRule[]>;
}

export interface SessionsFile {
  windows: { id: number; sessions: SavedSession[] }[];
  sessions: SavedSession[];
  notes: Record<string, string>;
  emulation: Record<string, EmulationOverrides>;
  mocks: Record<string, MockRule[]>;
}

export interface ParsedSessionsFile {
  windows: { sessions: SavedSession[] }[];
  notes: Record<string, string>;
  emulation: Record<string, EmulationOverrides>;
  mocks: Record<string, MockRule[]>;
}

/** Windows with no persistent tabs are left out: there is nothing to restore into them. */
export function buildSessionsFile(states: WindowSaveState[]): SessionsFile {
  const withTabs = states.filter((s) => s.sessions.length > 0);
  return {
    windows: withTabs.map((s, i) => ({ id: i + 1, sessions: s.sessions })),
    sessions: withTabs.flatMap((s) => s.sessions),
    notes: Object.assign({}, ...states.map((s) => s.notes)),
    emulation: Object.assign({}, ...states.map((s) => s.emulation)),
    mocks: Object.assign({}, ...states.map((s) => s.mocks)),
  };
}

const isRecord = (v: unknown): v is Record<string, never> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Accepts both formats; anything unreadable yields no windows. */
export function parseSessionsFile(raw: unknown): ParsedSessionsFile {
  const empty: ParsedSessionsFile = { windows: [], notes: {}, emulation: {}, mocks: {} };
  if (!isRecord(raw)) return empty;
  const f = raw as Record<string, unknown>;
  let windows: { sessions: SavedSession[] }[] = [];
  if (Array.isArray(f.windows)) {
    windows = f.windows
      .filter((w): w is { sessions: SavedSession[] } => isRecord(w) && Array.isArray((w as { sessions?: unknown }).sessions))
      .map((w) => ({ sessions: w.sessions }))
      .filter((w) => w.sessions.length > 0);
  } else if (Array.isArray(f.sessions) && f.sessions.length > 0) {
    windows = [{ sessions: f.sessions as SavedSession[] }];
  }
  return {
    windows,
    notes: isRecord(f.notes) ? (f.notes as Record<string, string>) : {},
    emulation: isRecord(f.emulation) ? (f.emulation as Record<string, EmulationOverrides>) : {},
    mocks: isRecord(f.mocks) ? (f.mocks as Record<string, MockRule[]>) : {},
  };
}
