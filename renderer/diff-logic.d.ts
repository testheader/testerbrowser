export interface TimelineEventLike {
  kind: string;
  ts: number;
  summary: string;
  payload?: string;
}

export interface NormaliseKeyOpts {
  mode?: 'full' | 'path';
  ignoreParams?: string[];
}

export const DEFAULT_IGNORED_PARAMS: string[];
export const DEFAULT_IGNORED_HEADERS: string[];

export function normaliseKey(method: string, url: string, opts?: NormaliseKeyOpts): string;
export function isTruncated(events: unknown[], limit: number): boolean;

export interface DiffCall {
  status: number | string;
  fromCache: boolean;
  requestId: string;
  durationMs: number | null;
  responseHeaders: Record<string, string>;
  body: { body: string; base64Encoded: boolean } | null;
}

export interface RequestMapEntry {
  method: string;
  url: string;
  calls: DiffCall[];
}

export function buildRequestMap(events: TimelineEventLike[], opts?: NormaliseKeyOpts): Map<string, RequestMapEntry>;

export interface HeaderDiff {
  added: { name: string; value: string }[];
  removed: { name: string; value: string }[];
  changed: { name: string; valueA: string; valueB: string }[];
}

export function diffHeaders(a?: Record<string, string>, b?: Record<string, string>, ignore?: string[]): HeaderDiff;

export interface DiffCellSummary {
  label: string;
  count: number;
  cache: 'none' | 'all' | 'mixed';
}

export interface DiffRowDetail {
  headerDiff: HeaderDiff;
  headersDiffer: boolean;
  bodiesMatch: boolean | null;
  bodySizeA: number | null;
  bodySizeB: number | null;
  durationA: number | null;
  durationB: number | null;
}

export interface DiffRow {
  key: string;
  method: string;
  url: string;
  a: DiffCellSummary | null;
  b: DiffCellSummary | null;
  category: 'same' | 'diff' | 'only-a' | 'only-b';
  detail: DiffRowDetail | null;
  headerBodyDiffer: boolean;
}

export interface ComputeDiffRowsOpts {
  groupDuplicates?: boolean;
  ignoreHeaders?: string[];
}

export function computeDiffRows(
  mapA: Map<string, RequestMapEntry>,
  mapB: Map<string, RequestMapEntry>,
  opts?: ComputeDiffRowsOpts
): DiffRow[];
