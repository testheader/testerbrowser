/* global testerBrowser */
import { state } from './state.js';

let baselineB64 = null;

export function initVR() {
  const panel = document.getElementById('vrPanel');
  if (panel.dataset.initialized) return;
  panel.dataset.initialized = '1';

  panel.innerHTML = `
    <div class="vr-toolbar">
      <button class="vr-btn" id="vrCaptureBtn">Capture baseline</button>
      <button class="vr-btn" id="vrCompareBtn" disabled>Compare</button>
      <span class="vr-stats" id="vrStats"></span>
    </div>
    <div class="vr-images" id="vrImages">
      <div class="vr-hint">Capture a baseline screenshot, interact with the page, then click Compare.</div>
    </div>`;

  document.getElementById('vrCaptureBtn').addEventListener('click', captureBaseline);
  document.getElementById('vrCompareBtn').addEventListener('click', runCompare);
}

async function captureBaseline() {
  if (!state.activeId) return;
  const captureBtn  = document.getElementById('vrCaptureBtn');
  const compareBtn  = document.getElementById('vrCompareBtn');
  const imagesDiv   = document.getElementById('vrImages');
  const stats       = document.getElementById('vrStats');

  captureBtn.disabled = true;
  captureBtn.textContent = 'Capturing…';
  stats.textContent = '';

  const b64 = await testerBrowser.visualRegression.captureScreenshot(state.activeId);
  captureBtn.disabled = false;
  captureBtn.textContent = 'Capture baseline';

  if (!b64) { stats.textContent = 'Screenshot failed.'; return; }

  baselineB64 = b64;
  compareBtn.disabled = false;
  imagesDiv.innerHTML = `<div class="vr-col"><div class="vr-col-label">Baseline</div><img class="vr-img" src="data:image/png;base64,${b64}" /></div>`;
  stats.textContent = 'Baseline captured. Interact with the page, then click Compare.';
}

async function runCompare() {
  if (!state.activeId || !baselineB64) return;
  const compareBtn = document.getElementById('vrCompareBtn');
  const imagesDiv  = document.getElementById('vrImages');
  const stats      = document.getElementById('vrStats');

  compareBtn.disabled = true;
  compareBtn.textContent = 'Comparing…';
  stats.textContent = '';

  try {
    const currentB64 = await testerBrowser.visualRegression.captureScreenshot(state.activeId);
    if (!currentB64) { stats.textContent = 'Screenshot failed.'; return; }

    const [baseImg, curImg] = await Promise.all([loadImage(baselineB64), loadImage(currentB64)]);

    const w = Math.max(baseImg.width,  curImg.width);
    const h = Math.max(baseImg.height, curImg.height);

    const { diffCanvas, diffCount, total } = computeDiff(baseImg, curImg, w, h);
    const pct = total > 0 ? ((diffCount / total) * 100).toFixed(2) : '0.00';

    const diffDataUrl = diffCanvas.toDataURL('image/png');

    imagesDiv.innerHTML = `
      <div class="vr-col"><div class="vr-col-label">Baseline</div><img class="vr-img" src="data:image/png;base64,${baselineB64}" /></div>
      <div class="vr-col"><div class="vr-col-label">Current</div><img class="vr-img" src="data:image/png;base64,${currentB64}" /></div>
      <div class="vr-col"><div class="vr-col-label">Diff</div><img class="vr-img" src="${diffDataUrl}" /></div>`;

    stats.textContent = `${diffCount.toLocaleString()} pixels differ (${pct}% of ${total.toLocaleString()})`;
  } catch (err) {
    stats.textContent = `Compare failed: ${err.message}`;
  } finally {
    compareBtn.disabled = false;
    compareBtn.textContent = 'Compare';
  }
}

function loadImage(b64) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = `data:image/png;base64,${b64}`;
  });
}

function computeDiff(img1, img2, w, h) {
  const c1 = new OffscreenCanvas(w, h);
  const c2 = new OffscreenCanvas(w, h);
  const cd = document.createElement('canvas');
  cd.width = w;
  cd.height = h;
  const x1 = c1.getContext('2d'), x2 = c2.getContext('2d'), xd = cd.getContext('2d');

  x1.drawImage(img1, 0, 0);
  x2.drawImage(img2, 0, 0);

  const d1 = x1.getImageData(0, 0, w, h).data;
  const d2 = x2.getImageData(0, 0, w, h).data;
  const out = xd.createImageData(w, h);

  let diffCount = 0;
  const total = w * h;

  for (let i = 0; i < total; i++) {
    const j = i * 4;
    const dr = Math.abs(d1[j]   - d2[j]);
    const dg = Math.abs(d1[j+1] - d2[j+1]);
    const db = Math.abs(d1[j+2] - d2[j+2]);
    if (dr + dg + db > 15) {
      out.data[j]   = 255;
      out.data[j+1] = 0;
      out.data[j+2] = 68;
      out.data[j+3] = 255;
      diffCount++;
    } else {
      out.data[j]   = Math.round(d1[j]   * 0.25);
      out.data[j+1] = Math.round(d1[j+1] * 0.25);
      out.data[j+2] = Math.round(d1[j+2] * 0.25);
      out.data[j+3] = 255;
    }
  }
  xd.putImageData(out, 0, 0);
  return { diffCanvas: cd, diffCount, total };
}
