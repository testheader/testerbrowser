import type { TimelineEventLike } from './utils';

export const requestMeta: Map<string, { method: string; url?: string }>;
export const responseMeta: Map<string, { status: number | null; durationMs?: number }>;
export const tagMeta: Map<string, 'mock' | 'resilience'>;

export interface NetworkFilters {
  activeTypes: Set<string>;
  activeMethods: Set<string>;
  minDuration: number;
  filterText: string;
}
export interface ConsoleFilters {
  activeLevels: Set<string>;
  filterText: string;
}

export function matchesNetworkFilters(e: TimelineEventLike, filters: NetworkFilters): boolean;
export function matchesConsoleFilters(e: TimelineEventLike, filters: ConsoleFilters): boolean;
export function getTimelineEvents(): TimelineEventLike[];
export function renderTimeline(): void;
export function pollTimeline(): Promise<void>;
export function refreshTimelineNow(): void;
export function resetTimelineForNewSession(): void;
export function initTimeline(): void;
