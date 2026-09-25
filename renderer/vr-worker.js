// Runs the per-pixel visual-regression diff off the main thread (#238) — a
// full-page capture up to MAX_CAPTURE_PX can be tens of millions of pixels,
// and that loop running on the UI thread visibly freezes the whole app for
// its duration. renderer/visual-regression.js posts the two same-size RGBA
// buffers here as transferable ArrayBuffers (zero-copy, so a large capture
// doesn't double its memory cost) and gets the diff buffer back the same way.
import { diffPixels } from './vr-diff.js';

self.onmessage = (e) => {
  const { w, h, buf1, buf2, threshold } = e.data;
  const data1 = new Uint8ClampedArray(buf1);
  const data2 = new Uint8ClampedArray(buf2);
  const { diffData, diffCount, total } = diffPixels(data1, data2, w, h, threshold);
  self.postMessage({ diffData: diffData.buffer, diffCount, total }, [diffData.buffer]);
};
