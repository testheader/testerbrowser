import path from 'path';

// Pure helpers behind the single result dialog shown after a snapshot export
// or import (#360). Kept free of Electron so they are unit-testable.

export interface SnapshotSummary {
  cookies: number;
  localStorageKeys: number;
  sessionStorageKeys: number;
  indexedDBDatabases: number;
  frames: number;
}

export type SnapshotResultKind = 'export' | 'import' | 'importNew';

export interface SnapshotResultDialog {
  type: 'info' | 'warning';
  title: string;
  message: string;
  detail: string;
}

const WARNING_CAP = 20;

interface FrameLike {
  localStorage?: Record<string, unknown>;
  sessionStorage?: Record<string, unknown>;
  indexedDB?: Record<string, unknown>;
}

const keyCount = (o: unknown): number =>
  o && typeof o === 'object' ? Object.keys(o as object).length : 0;

/**
 * Counts what a snapshot file contains. Handles the v2 `frames` array and the
 * v1 inline shape (storage at the top level, one implicit frame), mirroring the
 * fallback in SnapshotManager.restoreSnapshot().
 */
export function summarizeSnapshot(snap: Record<string, unknown>): SnapshotSummary {
  const frames: FrameLike[] = Array.isArray(snap.frames) && (snap.frames as unknown[]).length
    ? (snap.frames as FrameLike[])
    : [snap as FrameLike];
  const summary: SnapshotSummary = {
    cookies: Array.isArray(snap.cookies) ? snap.cookies.length : 0,
    localStorageKeys: 0,
    sessionStorageKeys: 0,
    indexedDBDatabases: 0,
    frames: frames.length,
  };
  for (const f of frames) {
    if (!f || typeof f !== 'object') continue;
    summary.localStorageKeys += keyCount(f.localStorage);
    summary.sessionStorageKeys += keyCount(f.sessionStorage);
    summary.indexedDBDatabases += keyCount(f.indexedDB);
  }
  return summary;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const NOT_SAVED = 'In-memory page state (for example React component state) is not saved in a snapshot.';
const NOT_RESTORED = 'Not restored: in-memory JavaScript state, such as React component state.';

function restoredLines(s: SnapshotSummary): string {
  return [
    `Restored: ${plural(s.cookies, 'cookie')}`,
    `${plural(s.localStorageKeys, 'localStorage key')}`,
    `${plural(s.sessionStorageKeys, 'sessionStorage key')}`,
    `${plural(s.indexedDBDatabases, 'IndexedDB database')}`,
    `${plural(s.frames, 'frame')}`,
  ].join(', ') + '.';
}

/**
 * Builds the one dialog shown after a successful export/import. Restore
 * warnings are appended to it (capped at 20 lines) and switch the type to
 * 'warning'; with none the type is 'info'.
 */
export function formatSnapshotResult(opts: {
  kind: SnapshotResultKind;
  fileName: string;
  summary?: SnapshotSummary;
  warnings?: string[];
}): SnapshotResultDialog {
  const { kind, fileName, summary } = opts;
  const warnings = opts.warnings ?? [];
  const base = path.basename(fileName);
  const parts: string[] = [];
  let title: string;
  let message: string;

  if (kind === 'export') {
    title = 'Snapshot exported';
    message = `Saved ${base}.`;
    parts.push(fileName);
    parts.push('To restore it: right-click a tab → Import snapshot… (replaces that tab\'s cookies and storage) or Import session… (opens it in a new tab).');
    parts.push(NOT_SAVED);
  } else {
    title = 'Snapshot imported';
    message = kind === 'import'
      ? `Applied ${base} to the current tab, replacing its cookies and storage.`
      : `Opened ${base} in a new tab.`;
    if (summary) parts.push(restoredLines(summary));
    parts.push(NOT_RESTORED);
  }

  if (warnings.length) {
    const shown = warnings.slice(0, WARNING_CAP).join('\n');
    parts.push(`Completed with ${warnings.length} warning(s):\n${shown}${warnings.length > WARNING_CAP ? `\n…and ${warnings.length - WARNING_CAP} more` : ''}`);
  }

  return { type: warnings.length ? 'warning' : 'info', title, message, detail: parts.join('\n\n') };
}
