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

export const REGION_CELL_PX = 16;
export const MAX_CHANGED_REGIONS = 500;

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
export function diffPixels(data1, data2, w, h, threshold = 15, regions = [], cellSize = REGION_CELL_PX) {
  const total = w * h;
  const out = new Uint8ClampedArray(total * 4);
  let diffCount = 0;
  let consideredTotal = total;
  const hasRegions = regions && regions.length > 0;
  // Differing pixels are also tallied into a coarse grid of cellSize×cellSize
  // cells, which clusterChangedCells() turns into the "changed regions" the
  // panel steps through — far cheaper than labelling individual pixels.
  const cols = Math.max(1, Math.ceil(w / cellSize));
  const rows = Math.max(1, Math.ceil(h / cellSize));
  const cells = new Uint32Array(cols * rows);

  for (let y = 0; y < h; y++) {
    const cellRow = ((y / cellSize) | 0) * cols;
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      if (hasRegions && pixelInAnyIgnoreRegion(x, y, regions)) {
        out[j]     = 128;
        out[j + 1] = 128;
        out[j + 2] = 128;
        out[j + 3] = 140;
        consideredTotal--;
        continue;
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
        cells[cellRow + ((x / cellSize) | 0)]++;
      } else {
        out[j]     = Math.round(data1[j]     * 0.25);
        out[j + 1] = Math.round(data1[j + 1] * 0.25);
        out[j + 2] = Math.round(data1[j + 2] * 0.25);
        out[j + 3] = 255;
      }
    }
  }

  const { regions: changedRegions, truncated } = diffCount > 0
    ? clusterChangedCells(cells, cols, rows, cellSize, w, h)
    : { regions: [], truncated: false };
  return { diffData: out, diffCount, total: consideredTotal, changedRegions, changedRegionsTruncated: truncated };
}

// Groups non-empty grid cells (a per-cell count of differing pixels, as
// diffPixels builds it) into connected clusters and returns each one's
// bounding box in image pixels, clipped to w×h, in reading order (top to
// bottom, then left to right) so "next change" moves predictably down the
// page. Cells up to `gap` empty cells apart still join one cluster — a line
// of changed text is one region, not one per glyph. At most `max` regions
// are returned; `truncated` says whether more existed.
export function clusterChangedCells(cells, cols, rows, cellSize, w, h, { gap = 1, max = MAX_CHANGED_REGIONS } = {}) {
  const seen = new Uint8Array(cols * rows);
  const found = [];
  const stack = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) continue;
    let minC = cols, minR = rows, maxC = -1, maxR = -1, pixels = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const idx = stack.pop();
      const c = idx % cols;
      const r = (idx / cols) | 0;
      pixels += cells[idx];
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      for (let dr = -gap - 1; dr <= gap + 1; dr++) {
        const nr = r + dr;
        if (nr < 0 || nr >= rows) continue;
        for (let dc = -gap - 1; dc <= gap + 1; dc++) {
          const nc = c + dc;
          if (nc < 0 || nc >= cols) continue;
          const n = nr * cols + nc;
          if (cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    const x = minC * cellSize;
    const y = minR * cellSize;
    found.push({
      x, y,
      w: Math.min(w, (maxC + 1) * cellSize) - x,
      h: Math.min(h, (maxR + 1) * cellSize) - y,
      pixels,
    });
  }
  found.sort((a, b) => a.y - b.y || a.x - b.x);
  return { regions: found.slice(0, max), truncated: found.length > max };
}
