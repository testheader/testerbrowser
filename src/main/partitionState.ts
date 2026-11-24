import type { EmulationOverrides } from './emulationManager';
import type { Rule } from './rules';
import type { PermissionRecord } from './permissionManager';
import type { JsonStore } from './jsonFile';
import { RaceGate } from './raceGate';

/** A window's SessionManager, as seen by hooks that are installed once per Electron session. */
export interface WebContentsOwner {
  ownsWebContentsId(webContentsId: number): boolean;
  noteLoadedDomain(webContentsId: number, host: string): void;
}

/**
 * State that belongs to a session *partition* rather than to one window
 * (#367): two tabs on the same partition share cookies, so they must also
 * share the Rules and Spoof overrides applied to it, even
 * when they live in different windows. One instance is created at startup and
 * handed to every window's SessionManager; each manager's sub-managers read
 * and write these maps instead of private ones.
 */
export interface SharedPartitionState {
  rules: Map<string, Rule[]>;
  emulation: Map<string, EmulationOverrides>;
  /** Partitions whose session-wide webRequest listener is installed (one per Electron session). */
  hookedPartitions: Set<string>;
  /** Every live window's manager, so a session-wide hook can find the tab's owner. */
  owners: Set<WebContentsOwner>;
  /** Live tabs per partition across all windows (an in-memory partition is wiped only at zero). */
  partitionRefs: Map<string, number>;
  /** Barrier behind `race` rules; shared so tabs on one partition (any window) fill the same gate. */
  raceGate: RaceGate;
  /** Persisted permission grants; created by the first manager, then shared. */
  permissionStore?: JsonStore<PermissionRecord[]>;
}

export function createSharedPartitionState(): SharedPartitionState {
  return {
    rules: new Map(), emulation: new Map(),
    hookedPartitions: new Set(), owners: new Set(), partitionRefs: new Map(),
    raceGate: new RaceGate(),
  };
}
