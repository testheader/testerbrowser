export interface IgnoreRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChangedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Number of differing pixels inside the region. */
  pixels: number;
}

export interface DiffPixelsResult {
  diffData: Uint8ClampedArray;
  diffCount: number;
  total: number;
  changedRegions: ChangedRegion[];
  changedRegionsTruncated: boolean;
}

export const REGION_CELL_PX: number;
export const MAX_CHANGED_REGIONS: number;

export function clusterChangedCells(
  cells: ArrayLike<number>,
  cols: number,
  rows: number,
  cellSize: number,
  w: number,
  h: number,
  opts?: { gap?: number; max?: number }
): { regions: ChangedRegion[]; truncated: boolean };

export function pixelInAnyIgnoreRegion(x: number, y: number, regions: IgnoreRegion[] | undefined): boolean;

export function diffPixels(
  data1: Uint8ClampedArray,
  data2: Uint8ClampedArray,
  w: number,
  h: number,
  threshold?: number,
  regions?: IgnoreRegion[],
  cellSize?: number
): DiffPixelsResult;
