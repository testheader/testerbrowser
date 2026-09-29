import { diffPixels, pixelInAnyIgnoreRegion } from '../../renderer/vr-diff.js';

// Builds a flat RGBA buffer for a w×h image, each pixel opaque [r,g,b,255].
function makeImage(w: number, h: number, [r, g, b]: [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    data[j] = r; data[j + 1] = g; data[j + 2] = b; data[j + 3] = 255;
  }
  return data;
}

describe('diffPixels', () => {
  it('reports zero differing pixels for identical images', () => {
    const a = makeImage(4, 4, [10, 20, 30]);
    const b = makeImage(4, 4, [10, 20, 30]);
    const { diffCount, total } = diffPixels(a, b, 4, 4);
    expect(total).toBe(16);
    expect(diffCount).toBe(0);
  });

  it('reports every pixel differing when all are past the threshold', () => {
    const a = makeImage(2, 2, [0, 0, 0]);
    const b = makeImage(2, 2, [255, 255, 255]);
    const { diffCount, total } = diffPixels(a, b, 2, 2);
    expect(diffCount).toBe(total);
  });

  it('a difference at or below the threshold does not count as differing', () => {
    // |dr|+|dg|+|db| = 15, the boundary itself — strictly greater than 15 counts.
    const a = makeImage(1, 1, [0, 0, 0]);
    const b = makeImage(1, 1, [5, 5, 5]);
    expect(diffPixels(a, b, 1, 1).diffCount).toBe(0);
  });

  it('a difference just past the threshold counts as differing', () => {
    const a = makeImage(1, 1, [0, 0, 0]);
    const b = makeImage(1, 1, [16, 0, 0]);
    expect(diffPixels(a, b, 1, 1).diffCount).toBe(1);
  });

  it('respects a custom threshold', () => {
    const a = makeImage(1, 1, [0, 0, 0]);
    const b = makeImage(1, 1, [10, 0, 0]);
    expect(diffPixels(a, b, 1, 1, 5).diffCount).toBe(1);
    expect(diffPixels(a, b, 1, 1, 20).diffCount).toBe(0);
  });

  it('marks a differing pixel with the diff highlight color, fully opaque', () => {
    const a = makeImage(1, 1, [0, 0, 0]);
    const b = makeImage(1, 1, [255, 255, 255]);
    const { diffData } = diffPixels(a, b, 1, 1);
    expect(Array.from(diffData)).toEqual([255, 0, 68, 255]);
  });

  it('dims a matching pixel to 25% of the baseline color, fully opaque', () => {
    const a = makeImage(1, 1, [100, 40, 200]);
    const b = makeImage(1, 1, [100, 40, 200]);
    const { diffData } = diffPixels(a, b, 1, 1);
    expect(Array.from(diffData)).toEqual([25, 10, 50, 255]);
  });

  it('counts only differing pixels among a mix, leaving the rest untouched', () => {
    // A 1×2 image: first pixel same, second pixel different.
    const a = new Uint8ClampedArray([10, 10, 10, 255, 0, 0, 0, 255]);
    const b = new Uint8ClampedArray([10, 10, 10, 255, 255, 255, 255, 255]);
    const { diffCount, total } = diffPixels(a, b, 1, 2);
    expect(total).toBe(2);
    expect(diffCount).toBe(1);
  });
});

describe('pixelInAnyIgnoreRegion (#277)', () => {
  it('returns false when there are no regions', () => {
    expect(pixelInAnyIgnoreRegion(5, 5, [])).toBe(false);
    expect(pixelInAnyIgnoreRegion(5, 5, undefined)).toBe(false);
  });

  it('is true for a point inside a region, false just outside it', () => {
    const regions = [{ x: 10, y: 10, w: 5, h: 5 }];
    expect(pixelInAnyIgnoreRegion(12, 12, regions)).toBe(true);
    expect(pixelInAnyIgnoreRegion(9, 12, regions)).toBe(false);
    expect(pixelInAnyIgnoreRegion(12, 16, regions)).toBe(false);
  });

  it('is half-open on the far edge — the top-left corner is inside, the bottom-right is not', () => {
    const regions = [{ x: 10, y: 10, w: 5, h: 5 }];
    expect(pixelInAnyIgnoreRegion(10, 10, regions)).toBe(true); // top-left corner, inclusive
    expect(pixelInAnyIgnoreRegion(15, 10, regions)).toBe(false); // x = 10 + w, exclusive
    expect(pixelInAnyIgnoreRegion(10, 15, regions)).toBe(false); // y = 10 + h, exclusive
    expect(pixelInAnyIgnoreRegion(14, 14, regions)).toBe(true); // last pixel actually inside
  });

  it('matches if the point is inside any one of several regions', () => {
    const regions = [{ x: 0, y: 0, w: 2, h: 2 }, { x: 100, y: 100, w: 2, h: 2 }];
    expect(pixelInAnyIgnoreRegion(1, 1, regions)).toBe(true);
    expect(pixelInAnyIgnoreRegion(101, 101, regions)).toBe(true);
    expect(pixelInAnyIgnoreRegion(50, 50, regions)).toBe(false);
  });
});

describe('diffPixels — ignore regions (#277)', () => {
  it('excludes an ignored differing pixel from diffCount and total, painting it with the ignored tint', () => {
    // A 1×2 image: both pixels differ, but the second is inside an ignore region.
    const a = new Uint8ClampedArray([0, 0, 0, 255,   0, 0, 0, 255]);
    const b = new Uint8ClampedArray([255, 255, 255, 255,   255, 255, 255, 255]);
    const regions = [{ x: 0, y: 1, w: 1, h: 1 }];
    const { diffData, diffCount, total } = diffPixels(a, b, 1, 2, 15, regions);
    expect(total).toBe(1); // the ignored pixel is excluded from the denominator too
    expect(diffCount).toBe(1); // only the non-ignored pixel counts
    expect(Array.from(diffData.slice(4, 8))).toEqual([128, 128, 128, 140]); // ignored tint, not the diff-red highlight
  });

  it('excludes an ignored *matching* pixel from total as well, not just a differing one', () => {
    const a = new Uint8ClampedArray([10, 10, 10, 255,   10, 10, 10, 255]);
    const b = new Uint8ClampedArray([10, 10, 10, 255,   10, 10, 10, 255]);
    const regions = [{ x: 0, y: 0, w: 1, h: 1 }];
    const { diffCount, total } = diffPixels(a, b, 1, 2, 15, regions);
    expect(total).toBe(1);
    expect(diffCount).toBe(0);
  });

  it('with no regions passed, behaves exactly as before (every pixel counted)', () => {
    const a = new Uint8ClampedArray([0, 0, 0, 255]);
    const b = new Uint8ClampedArray([255, 255, 255, 255]);
    const { diffCount, total } = diffPixels(a, b, 1, 1, 15);
    expect(total).toBe(1);
    expect(diffCount).toBe(1);
  });
});
