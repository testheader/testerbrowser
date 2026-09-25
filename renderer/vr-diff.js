// Pure pixel-diff core for visual regression comparison — no DOM, no Worker
// APIs, no OffscreenCanvas. Imported directly by renderer/vr-worker.js (the
// real Worker this runs inside off the main thread, so a full-page capture's
// tens of millions of pixels don't freeze the app), and importable as-is in
// a plain Jest/node test since it only touches typed arrays.
//
// data1/data2 are RGBA pixel buffers (Uint8ClampedArray, length w*h*4) —
// already the same dimensions by the time this runs: the caller draws both
// source images onto a canvas sized to their max width/height before
// extracting pixels, so a size mismatch between the original images shows
// up as padding here, not a length mismatch.
export function diffPixels(data1, data2, w, h, threshold = 15) {
  const total = w * h;
  const out = new Uint8ClampedArray(total * 4);
  let diffCount = 0;

  for (let i = 0; i < total; i++) {
    const j = i * 4;
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

  return { diffData: out, diffCount, total };
}
