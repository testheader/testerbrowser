// Pure presentation helpers for the UI diff (visual regression) panel — no
// DOM, no IPC, so they're unit-testable under plain Jest/node
// (src/__tests__/vr-logic.test.ts). renderer/visual-regression.js owns all
// the DOM wiring and calls into these.

// 'baseline' shows the baseline alone (and is where ignore regions are
// drawn); the other three only exist once a comparison has run.
export const VIEW_MODES = ['baseline', 'side', 'overlay', 'diff'];
export const COMPARE_VIEW_MODES = ['side', 'overlay', 'diff'];

// A remembered compare view (localStorage, so untrusted) back to a known
// one, or `fallback`.
export function normalizeViewMode(value, fallback = 'diff') {
  return COMPARE_VIEW_MODES.includes(value) ? value : fallback;
}

// Discrete zoom levels the −/+ buttons step between; 'fit' fits the whole
// image into the viewer, 'width' fits its width (for tall full-page shots).
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function normalizeZoom(value) {
  if (value === 'fit' || value === 'width') return value;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return ZOOM_STEPS.includes(n) ? n : 'fit';
}

// Scale (display px per image px) for a zoom setting. Fit modes never
// enlarge past 100% — a small screenshot blown up only blurs the pixels a
// tester is trying to inspect.
export function scaleForZoom(zoom, contentW, contentH, boxW, boxH) {
  if (typeof zoom === 'number') return zoom;
  if (!(contentW > 0) || !(contentH > 0) || !(boxW > 0)) return 1;
  const byWidth = boxW / contentW;
  if (zoom === 'width' || !(boxH > 0)) return Math.min(1, byWidth);
  return Math.min(1, byWidth, boxH / contentH);
}

// The next zoom step strictly above (dir > 0) or below (dir < 0) `scale`,
// clamped to the ends of ZOOM_STEPS — works from a fit-derived scale that
// isn't itself one of the steps.
export function stepZoom(scale, dir) {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > scale + 1e-9) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < scale - 1e-9) ?? ZOOM_STEPS[0];
}

export function formatZoom(scale) {
  return `${Math.round(scale * 100)}%`;
}

// When jumping to a changed region that would be tiny on screen at the
// current scale, the zoom level that makes it comfortably visible (about a
// third of the viewer, up to 400%) — never zooms *out*, and returns `scale`
// unchanged when the region is already big enough.
export const MIN_REGION_DISPLAY_PX = 40;
export function zoomToShowRegion(region, scale, boxW, boxH) {
  const shownW = region.w * scale;
  const shownH = region.h * scale;
  if (shownW >= MIN_REGION_DISPLAY_PX || shownH >= MIN_REGION_DISPLAY_PX) return scale;
  const wanted = Math.min(boxW / 3 / Math.max(1, region.w), boxH / 3 / Math.max(1, region.h));
  const step = [...ZOOM_STEPS].reverse().find((z) => z <= wanted) ?? ZOOM_STEPS[0];
  return Math.max(scale, step);
}

// Scroll offsets (for a scroll box of boxW×boxH, whose image starts at
// offsetX/offsetY inside it) that centre `region` in view.
export function scrollToCenter(region, scale, boxW, boxH, offsetX = 0, offsetY = 0) {
  const cx = offsetX + (region.x + region.w / 2) * scale;
  const cy = offsetY + (region.y + region.h / 2) * scale;
  return { left: Math.max(0, Math.round(cx - boxW / 2)), top: Math.max(0, Math.round(cy - boxH / 2)) };
}

// Previous/next index in a list of `count`, wrapping around; from "nothing
// selected" (-1) the first step lands on the first (or, backwards, last).
export function nextIndex(current, count, dir) {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return dir < 0 ? count - 1 : 0;
  return (current + (dir < 0 ? -1 : 1) + count) % count;
}

// "1.23" — but never "0.00" for a nonzero count, which would read as a pass.
export function formatPct(diffCount, total) {
  if (!(total > 0) || diffCount <= 0) return '0.00';
  const pct = (diffCount / total) * 100;
  if (pct < 0.01) return '<0.01';
  return pct.toFixed(2);
}

export const DEFAULT_MAX_DIFF_PCT = 0;

// The "Pass if at most N % changed" input, from a raw string (or a
// localStorage value): a finite number clamped to 0–100, else the default.
export function parseMaxDiffPct(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return DEFAULT_MAX_DIFF_PCT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_DIFF_PCT;
  return Math.min(100, Math.max(0, n));
}

// Pass/fail for a finished comparison. Differently sized screenshots always
// fail: the padding a mismatch introduces makes the % meaningless.
export function compareVerdict({ diffCount, total, sizeMismatch }, maxDiffPct) {
  if (sizeMismatch) return { pass: false, label: 'Fail', reason: 'The screenshots are different sizes' };
  const pct = total > 0 ? (diffCount / total) * 100 : 0;
  const shown = formatPct(diffCount, total);
  if (pct <= maxDiffPct) {
    return { pass: true, label: 'Pass', reason: `${shown}% changed, allowed up to ${maxDiffPct}%` };
  }
  return { pass: false, label: 'Fail', reason: `${shown}% changed, more than the ${maxDiffPct}% allowed` };
}

export const DEFAULT_THRESHOLD = 15;
export const MAX_THRESHOLD = 765;

export function parseThreshold(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(MAX_THRESHOLD, Math.max(0, n)) : DEFAULT_THRESHOLD;
}

// Plain-language reading of the per-pixel colour tolerance (the summed
// R+G+B difference, 0–765, above which a pixel counts as changed).
export function thresholdHint(threshold) {
  if (threshold <= 0) return 'Exact: any colour change at all counts.';
  if (threshold <= 30) return 'Strict: ignores faint anti-aliasing noise, catches subtle colour changes.';
  if (threshold <= 90) return 'Moderate: ignores small colour shifts, catches visible changes.';
  if (threshold < 300) return 'Lenient: only clearly different colours count.';
  if (threshold < MAX_THRESHOLD) return 'Very lenient: only drastic colour changes count.';
  return 'Off: no pixel can count as changed at this value.';
}

// Two drag points (image px) to a normalised rectangle.
export function rectFromPoints(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

// A rectangle clipped to a w×h image (rounded to whole pixels), or null
// when nothing of it is left or it's too thin to be a deliberate region.
export function clampRegion(r, w, h, minSize = 2) {
  const x0 = Math.max(0, Math.round(r.x));
  const y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(w, Math.round(r.x + r.w));
  const y1 = Math.min(h, Math.round(r.y + r.h));
  if (x1 - x0 < minSize || y1 - y0 < minSize) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Index of the topmost (last drawn) region containing the point, or -1.
export function regionIndexAt(pt, regions) {
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i];
    if (pt.x >= r.x && pt.x < r.x + r.w && pt.y >= r.y && pt.y < r.y + r.h) return i;
  }
  return -1;
}

// Pixels of a w×h image covered by at least one region — overlapping
// regions count once (coordinate compression over the region edges).
export function regionsCoverage(regions, w, h) {
  const rects = regions.map((r) => clampRegion(r, w, h, 1)).filter(Boolean);
  if (!rects.length) return 0;
  const xs = [...new Set(rects.flatMap((r) => [r.x, r.x + r.w]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    const spans = rects
      .filter((r) => r.x <= x0 && r.x + r.w >= x1)
      .map((r) => [r.y, r.y + r.h])
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let curStart = -1;
    let curEnd = -1;
    for (const [s, e] of spans) {
      if (s > curEnd) {
        covered += curEnd - curStart;
        curStart = s;
        curEnd = e;
      } else if (e > curEnd) {
        curEnd = e;
      }
    }
    covered += curEnd - curStart;
    area += covered * (x1 - x0);
  }
  return area;
}

export function describeRegion(r) {
  return `${r.w}×${r.h} at ${r.x}, ${r.y}`;
}

// Saved-baseline list filter: every whitespace-separated term must appear
// (case-insensitively) in the name or the URL.
export function filterBaselines(list, query) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return list;
  return list.filter((b) => {
    const hay = `${b.name || ''} ${b.url || ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

// Which of the three steps (1 baseline, 2 current page, 3 compare) are
// done, and which one the tester should do next (null once all are done).
export function stepState({ hasBaseline, hasResult }) {
  const done = [hasBaseline, hasResult, hasResult];
  const current = !hasBaseline ? 1 : !hasResult ? 2 : null;
  return { done, current };
}
