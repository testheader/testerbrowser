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
  request: DiffRequest;
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
  bodyA: { body: string; base64Encoded: boolean } | null;
  bodyB: { body: string; base64Encoded: boolean } | null;
}

export interface DiffRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData: string | null;
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
  /** First call's request on each side (for Copy as cURL); null when that side has none. */
  requestA: DiffRequest | null;
  requestB: DiffRequest | null;
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

// ── Presentation helpers ──
export type DiffBucket = 'changed' | 'added' | 'removed' | 'unchanged';
export const DIFF_BUCKETS: DiffBucket[];
export const STATUS_CLASSES: string[];

/** The subset of DiffRow the presentation helpers read. */
export interface DiffRowLike {
  category: string;
  headerBodyDiffer?: boolean;
  url: string;
  a: { label: string } | null;
  b: { label: string } | null;
}

export function rowBucket(row: DiffRowLike): DiffBucket;
export function summarizeDiffRows(rows: DiffRowLike[]): Record<DiffBucket | 'total', number>;
export function statusClassOf(status: number | string): string;
export function rowStatusClasses(row: DiffRowLike): Set<string>;
export function filterDiffRows<T extends DiffRowLike>(
  rows: T[],
  opts?: { buckets?: Set<string>; statusClasses?: Set<string>; text?: string }
): T[];
export function splitUrlForDisplay(url: string): { host: string; path: string };
export function splitChange(a: string, b: string): { prefix: string; midA: string; midB: string; suffix: string };
export function bodyTextForDiff(body: { body: string; base64Encoded: boolean } | null | undefined): string | null;

export interface LineDiffLine { type: ' ' | '-' | '+' | 'gap'; text?: string; count?: number }
export interface LineDiffResult {
  lines: LineDiffLine[];
  identical: boolean;
  truncated: boolean;
  tooLarge: boolean;
  firstDiffLine?: number;
}
export function lineDiff(
  textA: string,
  textB: string,
  opts?: { context?: number; maxLines?: number; maxCells?: number }
): LineDiffResult;
