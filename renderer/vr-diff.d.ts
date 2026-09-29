export interface IgnoreRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiffPixelsResult {
  diffData: Uint8ClampedArray;
  diffCount: number;
  total: number;
}

export function pixelInAnyIgnoreRegion(x: number, y: number, regions: IgnoreRegion[] | undefined): boolean;

export function diffPixels(
  data1: Uint8ClampedArray,
  data2: Uint8ClampedArray,
  w: number,
  h: number,
  threshold?: number,
  regions?: IgnoreRegion[]
): DiffPixelsResult;
