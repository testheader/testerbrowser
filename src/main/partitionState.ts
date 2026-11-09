import type { EmulationOverrides } from './emulationManager';
import type { MockRule } from './mockManager';
import type { ResilienceRule } from './resilienceManager';

/**
 * State that belongs to a session *partition* rather than to one window
 * (#367): two tabs on the same partition share cookies, so they must also
 * share the Mock/Resilience rules and Spoof overrides applied to it, even
 * when they live in different windows. One instance is created at startup and
 * handed to every window's SessionManager; each manager's sub-managers read
 * and write these maps instead of private ones.
 */
export interface SharedPartitionState {
  mockRules: Map<string, MockRule[]>;
  resilienceRules: Map<string, ResilienceRule[]>;
  emulation: Map<string, EmulationOverrides>;
}

export function createSharedPartitionState(): SharedPartitionState {
  return { mockRules: new Map(), resilienceRules: new Map(), emulation: new Map() };
}
