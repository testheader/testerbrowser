export interface DiffPixelsResult {
  diffData: Uint8ClampedArray;
  diffCount: number;
  total: number;
}

export function diffPixels(
  data1: Uint8ClampedArray,
  data2: Uint8ClampedArray,
  w: number,
  h: number,
  threshold?: number
): DiffPixelsResult;
