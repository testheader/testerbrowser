export type ViewMode = 'baseline' | 'side' | 'overlay' | 'diff';
export type CompareViewMode = 'side' | 'overlay' | 'diff';
export type Zoom = 'fit' | 'width' | number;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const VIEW_MODES: ViewMode[];
export const COMPARE_VIEW_MODES: CompareViewMode[];
export function normalizeViewMode(value: unknown, fallback?: CompareViewMode): CompareViewMode;

export const ZOOM_STEPS: number[];
export function normalizeZoom(value: unknown): Zoom;
export function scaleForZoom(zoom: Zoom, contentW: number, contentH: number, boxW: number, boxH: number): number;
export function stepZoom(scale: number, dir: number): number;
export function formatZoom(scale: number): string;

export const MIN_REGION_DISPLAY_PX: number;
export function zoomToShowRegion(region: Rect, scale: number, boxW: number, boxH: number): number;
export function scrollToCenter(
  region: Rect, scale: number, boxW: number, boxH: number, offsetX?: number, offsetY?: number
): { left: number; top: number };

export function nextIndex(current: number, count: number, dir: number): number;

export function formatPct(diffCount: number, total: number): string;
export const DEFAULT_MAX_DIFF_PCT: number;
export function parseMaxDiffPct(raw: unknown): number;
export function compareVerdict(
  result: { diffCount: number; total: number; sizeMismatch: boolean },
  maxDiffPct: number
): { pass: boolean; label: 'Pass' | 'Fail'; reason: string };

export const DEFAULT_THRESHOLD: number;
export const MAX_THRESHOLD: number;
export function parseThreshold(raw: unknown): number;
export function thresholdHint(threshold: number): string;

export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect;
export function clampRegion(r: Rect, w: number, h: number, minSize?: number): Rect | null;
export function regionIndexAt(pt: { x: number; y: number }, regions: Rect[]): number;
export function regionsCoverage(regions: Rect[], w: number, h: number): number;
export function describeRegion(r: Rect): string;

export function filterBaselines<T extends { name?: string; url?: string }>(list: T[], query: string): T[];

export function stepState(s: { hasBaseline: boolean; hasResult: boolean }): {
  done: [boolean, boolean, boolean];
  current: 1 | 2 | null;
};
