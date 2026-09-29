// Pure pixel-diff core for visual regression comparison — no DOM, no Worker
// APIs, no OffscreenCanvas. Imported directly by renderer/vr-worker.js (the
// real Worker this runs inside off the main thread, so a full-page capture's
// tens of millions of pixels don't freeze the app), and importable as-is in
// a plain Jest/node test since it only touches typed arrays.
//
// #277: true when (x, y) falls inside any of `regions` — image-pixel
// coordinates, half-open on the right/bottom edge (x in [r.x, r.x+r.w)),
// matching how a drawn rectangle's own width/height are interpreted
// everywhere else in this feature. Exported standalone (pure, no canvas)
// so its boundary behavior is directly unit-testable.
export function pixelInAnyIgnoreRegion(x, y, regions) {
  if (!regions || regions.length === 0) return false;
  return regions.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

// data1/data2 are RGBA pixel buffers (Uint8ClampedArray, length w*h*4) —
// already the same dimensions by the time this runs: the caller draws both
// source images onto a canvas sized to their max width/height before
// extracting pixels, so a size mismatch between the original images shows
// up as padding here, not a length mismatch.
//
// #277: `regions` (image-pixel {x,y,w,h} rectangles) are excluded from both
// diffCount and `total` — a pixel inside one never counts toward either the
// numerator or the denominator of the diff percentage, so a page with a
// known-dynamic region (a live clock, an ad slot) doesn't read as "worse"
// just because that region is excluded, and doesn't dilute the ratio for
// the region that's actually being checked either. Painted with a distinct
// translucent-gray "ignored" tint, visually different from both the
// diff-red highlight and the dimmed-match baseline tint, so it's clear the
// region was excluded rather than silently matching.
export function diffPixels(data1, data2, w, h, threshold = 15, regions = []) {
  const total = w * h;
  const out = new Uint8ClampedArray(total * 4);
  let diffCount = 0;
  let consideredTotal = total;
  const hasRegions = regions && regions.length > 0;

  for (let i = 0; i < total; i++) {
    const j = i * 4;
    if (hasRegions) {
      const x = i % w;
      const y = (i / w) | 0;
      if (pixelInAnyIgnoreRegion(x, y, regions)) {
        out[j]     = 128;
        out[j + 1] = 128;
        out[j + 2] = 128;
        out[j + 3] = 140;
        consideredTotal--;
        continue;
      }
    }
    const dr = Math.abs(data1[j]     - data2[j]);
    const dg = Math.abs(data1[j + 1] - data2[j + 1]);
    const db = Math.abs(data1[j + 2] - data2[j + 2]);
    if (dr + dg + db > threshold) {
      out[j]     = 255;
      out[j + 1] = 0;
      out[j + 2] = 68;
      out[j + 3] = 255;
      diffCount++;
    } else {
      out[j]     = Math.round(data1[j]     * 0.25);
      out[j + 1] = Math.round(data1[j + 1] * 0.25);
      out[j + 2] = Math.round(data1[j + 2] * 0.25);
      out[j + 3] = 255;
    }
  }

  return { diffData: out, diffCount, total: consideredTotal };
}
