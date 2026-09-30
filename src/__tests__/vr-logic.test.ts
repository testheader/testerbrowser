import {
  normalizeViewMode, normalizeZoom, scaleForZoom, stepZoom, formatZoom, ZOOM_STEPS,
  zoomToShowRegion, scrollToCenter, nextIndex, formatPct, parseMaxDiffPct, compareVerdict,
  parseThreshold, thresholdHint, rectFromPoints, clampRegion, regionIndexAt, regionsCoverage,
  describeRegion, filterBaselines, stepState,
} from '../../renderer/vr-logic.js';

describe('view mode + zoom preferences', () => {
  it('only restores a known compare view, else the fallback', () => {
    expect(normalizeViewMode('overlay')).toBe('overlay');
    expect(normalizeViewMode('side')).toBe('side');
    expect(normalizeViewMode('baseline')).toBe('diff');
    expect(normalizeViewMode(null)).toBe('diff');
    expect(normalizeViewMode('<script>', 'side')).toBe('side');
  });

  it('normalizes zoom to fit, width or one of the steps', () => {
    expect(normalizeZoom('fit')).toBe('fit');
    expect(normalizeZoom('width')).toBe('width');
    expect(normalizeZoom('0.5')).toBe(0.5);
    expect(normalizeZoom(2)).toBe(2);
    expect(normalizeZoom('0.33')).toBe('fit');
    expect(normalizeZoom(null)).toBe('fit');
  });

  it('fits the whole image, or its width, never enlarging past 100%', () => {
    expect(scaleForZoom('fit', 1000, 2000, 500, 500)).toBe(0.25);
    expect(scaleForZoom('width', 1000, 2000, 500, 500)).toBe(0.5);
    expect(scaleForZoom('fit', 100, 100, 1000, 1000)).toBe(1);
    expect(scaleForZoom(2, 100, 100, 10, 10)).toBe(2);
    expect(scaleForZoom('fit', 100, 100, 0, 0)).toBe(1); // hidden panel measures 0×0
  });

  it('steps to the next zoom level strictly above/below, clamped at the ends', () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.37, 1)).toBe(0.5);
    expect(stepZoom(0.37, -1)).toBe(0.25);
    expect(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1], 1)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(ZOOM_STEPS[0]);
    expect(formatZoom(0.254)).toBe('25%');
  });
});

describe('changed-region navigation', () => {
  it('wraps around and starts from the first (or last) region', () => {
    expect(nextIndex(-1, 3, 1)).toBe(0);
    expect(nextIndex(-1, 3, -1)).toBe(2);
    expect(nextIndex(2, 3, 1)).toBe(0);
    expect(nextIndex(0, 3, -1)).toBe(2);
    expect(nextIndex(1, 3, 1)).toBe(2);
    expect(nextIndex(0, 0, 1)).toBe(-1);
    expect(nextIndex(7, 3, 1)).toBe(0);
  });

  it('zooms in on a region that would be tiny on screen, never out', () => {
    const tiny = { x: 10, y: 10, w: 8, h: 8 };
    const z = zoomToShowRegion(tiny, 0.25, 900, 600);
    expect(z).toBeGreaterThan(0.25);
    expect(ZOOM_STEPS).toContain(z);
    expect(z).toBeLessThanOrEqual(4);
    const big = { x: 0, y: 0, w: 400, h: 300 };
    expect(zoomToShowRegion(big, 0.25, 900, 600)).toBe(0.25);
    // Already very zoomed in: stays put.
    expect(zoomToShowRegion({ x: 0, y: 0, w: 5, h: 5 }, 4, 100, 100)).toBe(4);
  });

  it('centres a region in the scroll box, clamped at zero', () => {
    expect(scrollToCenter({ x: 1000, y: 500, w: 100, h: 100 }, 1, 400, 200)).toEqual({ left: 850, top: 450 });
    expect(scrollToCenter({ x: 1000, y: 500, w: 100, h: 100 }, 0.5, 400, 200, 10, 20)).toEqual({ left: 335, top: 195 });
    expect(scrollToCenter({ x: 0, y: 0, w: 10, h: 10 }, 1, 400, 200)).toEqual({ left: 0, top: 0 });
  });
});

describe('result summary', () => {
  it('never shows a nonzero difference as 0.00%', () => {
    expect(formatPct(0, 100)).toBe('0.00');
    expect(formatPct(1, 1_000_000)).toBe('<0.01');
    expect(formatPct(1234, 100_000)).toBe('1.23');
    expect(formatPct(5, 0)).toBe('0.00');
  });

  it('parses the allowed-change limit, clamped to 0–100', () => {
    expect(parseMaxDiffPct('0.5')).toBe(0.5);
    expect(parseMaxDiffPct('-3')).toBe(0);
    expect(parseMaxDiffPct('250')).toBe(100);
    expect(parseMaxDiffPct('abc')).toBe(0);
    expect(parseMaxDiffPct(null)).toBe(0);
    expect(parseMaxDiffPct('')).toBe(0);
  });

  it('passes at or under the limit, fails over it or on a size mismatch', () => {
    expect(compareVerdict({ diffCount: 0, total: 100, sizeMismatch: false }, 0).pass).toBe(true);
    expect(compareVerdict({ diffCount: 1, total: 100, sizeMismatch: false }, 0).pass).toBe(false);
    expect(compareVerdict({ diffCount: 1, total: 100, sizeMismatch: false }, 1).pass).toBe(true);
    const mismatch = compareVerdict({ diffCount: 0, total: 100, sizeMismatch: true }, 50);
    expect(mismatch.pass).toBe(false);
    expect(mismatch.reason).toMatch(/different sizes/);
    expect(compareVerdict({ diffCount: 2, total: 100, sizeMismatch: false }, 1).reason).toBe('2.00% changed, more than the 1% allowed');
  });
});

describe('colour tolerance', () => {
  it('clamps to 0–765 and falls back to the default for junk', () => {
    expect(parseThreshold('40')).toBe(40);
    expect(parseThreshold('-1')).toBe(0);
    expect(parseThreshold('9999')).toBe(765);
    expect(parseThreshold('x')).toBe(15);
  });

  it('describes each band in plain language', () => {
    expect(thresholdHint(0)).toMatch(/^Exact/);
    expect(thresholdHint(15)).toMatch(/^Strict/);
    expect(thresholdHint(60)).toMatch(/^Moderate/);
    expect(thresholdHint(150)).toMatch(/^Lenient/);
    expect(thresholdHint(500)).toMatch(/^Very lenient/);
    expect(thresholdHint(765)).toMatch(/^Off/);
  });
});

describe('ignore regions', () => {
  it('normalizes a drag in any direction', () => {
    expect(rectFromPoints({ x: 50, y: 40 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 20 });
  });

  it('clips to the image and drops slivers', () => {
    expect(clampRegion({ x: -10, y: 5, w: 30, h: 10 }, 100, 100)).toEqual({ x: 0, y: 5, w: 20, h: 10 });
    expect(clampRegion({ x: 90, y: 90, w: 50, h: 50 }, 100, 100)).toEqual({ x: 90, y: 90, w: 10, h: 10 });
    expect(clampRegion({ x: 10, y: 10, w: 1, h: 50 }, 100, 100)).toBeNull();
    expect(clampRegion({ x: 200, y: 10, w: 10, h: 10 }, 100, 100)).toBeNull();
  });

  it('finds the topmost region under a point (half-open edges)', () => {
    const regions = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }];
    expect(regionIndexAt({ x: 6, y: 6 }, regions)).toBe(1);
    expect(regionIndexAt({ x: 1, y: 1 }, regions)).toBe(0);
    expect(regionIndexAt({ x: 15, y: 15 }, regions)).toBe(-1);
  });

  it('counts overlapping coverage once and clips to the image', () => {
    expect(regionsCoverage([], 100, 100)).toBe(0);
    expect(regionsCoverage([{ x: 0, y: 0, w: 10, h: 10 }], 100, 100)).toBe(100);
    expect(regionsCoverage([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }], 100, 100)).toBe(175);
    expect(regionsCoverage([{ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }], 100, 100)).toBe(100);
    expect(regionsCoverage([{ x: 95, y: 95, w: 10, h: 10 }], 100, 100)).toBe(25);
    expect(regionsCoverage([{ x: 0, y: 0, w: 10, h: 2 }, { x: 0, y: 8, w: 10, h: 2 }], 100, 100)).toBe(40);
  });

  it('describes a region for its chip label', () => {
    expect(describeRegion({ x: 10, y: 20, w: 120, h: 40 })).toBe('120×40 at 10, 20');
  });
});

describe('saved baselines + steps', () => {
  const list = [
    { id: 'a', name: 'Login page', url: 'https://staging.example.com/login' },
    { id: 'b', name: 'Checkout', url: 'https://example.com/cart' },
  ];

  it('filters by every term, across name and URL, case-insensitively', () => {
    expect(filterBaselines(list, '')).toBe(list);
    expect(filterBaselines(list, 'login').map((b) => b.id)).toEqual(['a']);
    expect(filterBaselines(list, 'EXAMPLE cart').map((b) => b.id)).toEqual(['b']);
    expect(filterBaselines(list, 'staging checkout')).toEqual([]);
  });

  it('marks steps done and points at the next one', () => {
    expect(stepState({ hasBaseline: false, hasResult: false })).toEqual({ done: [false, false, false], current: 1 });
    expect(stepState({ hasBaseline: true, hasResult: false })).toEqual({ done: [true, false, false], current: 2 });
    expect(stepState({ hasBaseline: true, hasResult: true })).toEqual({ done: [true, true, true], current: null });
  });
});
