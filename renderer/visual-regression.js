/* global testerBrowser */
import { getActiveId } from './tabs.js';
import { buildSessionOptions } from './session-picker.js';
import { escHtml } from './utils.js';

// Lazily created, reused across comparisons — spinning up a Worker has real
// overhead, and every compare goes through the same one at most one at a
// time (see computeDiffInWorker's own listener lifecycle).
let vrWorker = null;
function getVrWorker() {
  // Relative to the page's own URL (renderer/index.html), not this module's
  // — both live in the same renderer/ directory, so a plain relative path
  // resolves correctly either way. Deliberately not import.meta.url: this
  // file is also loaded (for its non-Worker exports) by Jest's CommonJS
  // transform when other renderer modules pull it in transitively, which
  // can't parse that syntax.
  if (!vrWorker) vrWorker = new Worker('./vr-worker.js', { type: 'module' });
  return vrWorker;
}

// Baseline capture is page-scoped (per session, see #88), but the "current"
// screenshot compared against it can come from a different session — see #127.
// #277: baselineId is set once the active baseline is a *saved* one (either
// just-saved, or loaded from the Baselines list) — null for one freshly
// captured in this tab but never saved. ignoreRegions are the working set
// for the active baseline (image-pixel {x,y,w,h} rectangles); edits while
// baselineId is set persist immediately via setIgnoreRegions so they're
// remembered next time that saved baseline is used, per the ticket.
const sessionData = new Map(); // sessionId -> { baselineB64, baselineId, currentB64, diffDataUrl, viewMode, compareSessionId, threshold, ignoreRegions }

export function clearVRSession(sessionId) {
  sessionData.delete(sessionId);
}

const DEFAULT_THRESHOLD = 15;

function emptyData() {
  return {
    baselineB64: null, baselineId: null, currentB64: null, diffDataUrl: null,
    viewMode: 'baseline', compareSessionId: '', threshold: DEFAULT_THRESHOLD, ignoreRegions: [],
  };
}

function activeData() {
  if (!getActiveId()) return emptyData();
  let d = sessionData.get(getActiveId());
  if (!d) {
    d = emptyData();
    sessionData.set(getActiveId(), d);
  }
  return d;
}

export function initVR() {
  const panel = document.getElementById('vrPanel');
  if (panel.dataset.initialized) return;
  panel.dataset.initialized = '1';

  panel.innerHTML = `
    <div class="vr-toolbar">
      <div class="vr-toolbar-row">
        <span class="vr-toolbar-label">Capture</span>
        <button class="vr-btn" id="vrCaptureBtn">Capture baseline</button>
        <label class="diff-label" title="Session to capture the 'current' screenshot from when comparing">Compare against
          <select class="diff-pick" id="vrComparePick"></select>
        </label>
        <button class="vr-btn" id="vrCompareBtn" disabled>Compare</button>
        <label class="vr-toggle" title="Capture the whole scrollable page instead of just the viewport">
          <input type="checkbox" id="vrFullPage" /> Full page
        </label>
        <span class="vr-stats" id="vrStats"></span>
      </div>
      <div class="vr-toolbar-row">
        <span class="vr-toolbar-label">Baselines</span>
        <select class="diff-pick" id="vrBaselinePick" aria-label="Saved baselines"><option value="">— saved baselines —</option></select>
        <button class="vr-btn" id="vrLoadBaselineBtn" disabled>Load</button>
        <button class="vr-btn" id="vrSaveBaselineBtn" disabled title="Save the current baseline screenshot for reuse across sessions and restarts">Save as…</button>
        <button class="vr-btn" id="vrExportBaselineBtn" disabled title="Export the selected saved baseline as a PNG + sidecar JSON pair">Export…</button>
        <button class="vr-btn" id="vrImportBaselineBtn" title="Import a baseline previously exported from this or another machine">Import…</button>
        <button class="vr-btn" id="vrDeleteBaselineBtn" disabled>Delete</button>
        <span class="status-msg" id="vrBaselineStatus"></span>
      </div>
      <div class="vr-toolbar-row">
        <span class="vr-toolbar-label">View</span>
        <div class="vr-views" id="vrViews">
          <button class="vr-btn vr-view-btn active" data-view="baseline">Baseline</button>
          <button class="vr-btn vr-view-btn" data-view="current" disabled>Current</button>
          <button class="vr-btn vr-view-btn" data-view="diff"    disabled>Diff</button>
          <button class="vr-btn vr-view-btn" data-view="compare" disabled>Compare view</button>
        </div>
        <label class="diff-label" for="vrThreshold" title="Per-pixel color difference (summed across R+G+B, 0-765 max) above which a pixel counts as differing. Higher = more lenient.">Threshold
          <input type="number" id="vrThreshold" min="0" max="765" value="${DEFAULT_THRESHOLD}" class="vr-threshold-input" />
        </label>
        <button class="vr-btn" id="vrEditRegionsBtn" disabled title="Draw rectangles on the baseline to exclude from comparison">Edit ignore regions</button>
        <span class="vr-hint" id="vrRegionsHint" hidden>Drag to draw a region to ignore · click an existing region to remove it</span>
      </div>
    </div>
    <div class="vr-images" id="vrImages">
      <div class="vr-hint">Capture a baseline screenshot, interact with the page, then click Compare.</div>
    </div>`;

  document.getElementById('vrCaptureBtn').addEventListener('click', captureBaseline);
  document.getElementById('vrCompareBtn').addEventListener('click', runCompare);
  document.getElementById('vrViews').addEventListener('click', (e) => {
    const btn = e.target.closest('.vr-view-btn');
    if (!btn || btn.disabled) return;
    activeData().viewMode = btn.dataset.view;
    renderImages();
  });
  document.getElementById('vrComparePick').addEventListener('change', (e) => {
    activeData().compareSessionId = e.target.value;
  });
  document.getElementById('vrThreshold').addEventListener('change', (e) => {
    const n = parseInt(e.target.value, 10);
    activeData().threshold = Number.isFinite(n) ? Math.min(765, Math.max(0, n)) : DEFAULT_THRESHOLD;
    e.target.value = String(activeData().threshold);
  });
  document.getElementById('vrEditRegionsBtn').addEventListener('click', toggleRegionsEditMode);
  document.getElementById('vrBaselinePick').addEventListener('change', () => {
    const picked = document.getElementById('vrBaselinePick').value;
    document.getElementById('vrLoadBaselineBtn').disabled = !picked;
    document.getElementById('vrExportBaselineBtn').disabled = !picked;
    document.getElementById('vrDeleteBaselineBtn').disabled = !picked;
  });
  document.getElementById('vrLoadBaselineBtn').addEventListener('click', loadSelectedBaseline);
  document.getElementById('vrSaveBaselineBtn').addEventListener('click', saveActiveBaseline);
  document.getElementById('vrExportBaselineBtn').addEventListener('click', exportSelectedBaseline);
  document.getElementById('vrImportBaselineBtn').addEventListener('click', importBaseline);
  document.getElementById('vrDeleteBaselineBtn').addEventListener('click', deleteSelectedBaseline);

  refreshBaselinesList();

  refreshVRComparePicker();
}

// Repopulates the "Compare against" session picker. Called on init and
// whenever the session list changes (new/closed/renamed tabs), independent
// of whether the VR tab is currently visible — so the list is current
// whenever the user opens it, without disturbing an in-progress comparison
// the way a full refreshVR() (which resets stats/view) would.
export async function refreshVRComparePicker() {
  const pick = document.getElementById('vrComparePick');
  if (!pick) return; // panel not initialized yet

  const sessions = await testerBrowser.sessions.list();
  const current = pick.value;
  buildSessionOptions(pick, sessions, { extraFirstOption: { value: '', label: 'This session (same as baseline)' } });

  const stillValid = current && sessions.some(s => s.id === current);
  pick.value = stillValid ? current : '';
  activeData().compareSessionId = pick.value;
}

// Re-render the panel for the currently active session — called on init and
// whenever the user switches sessions, so a baseline never silently gets
// compared against a different session's page.
export function refreshVR() {
  const compareBtn = document.getElementById('vrCompareBtn');
  const stats       = document.getElementById('vrStats');
  const comparePick = document.getElementById('vrComparePick');
  const thresholdInput = document.getElementById('vrThreshold');
  const editRegionsBtn = document.getElementById('vrEditRegionsBtn');
  const saveBaselineBtn = document.getElementById('vrSaveBaselineBtn');
  if (!compareBtn) return; // panel not initialized yet
  const data = activeData();
  compareBtn.disabled = !data.baselineB64;
  if (editRegionsBtn) editRegionsBtn.disabled = !data.baselineB64;
  if (saveBaselineBtn) saveBaselineBtn.disabled = !data.baselineB64;
  if (stats) stats.textContent = '';
  // The picker is one shared element — resync its displayed value to the
  // newly-active session's own stored preference, not whatever was left
  // showing for the previously active session.
  if (comparePick) comparePick.value = data.compareSessionId || '';
  if (thresholdInput) thresholdInput.value = String(data.threshold);
  // Switching sessions leaves regions-edit mode — it's tied to whichever
  // session's baseline is on screen, and following the active session into
  // it unannounced would let a drag meant for one baseline edit another's.
  regionsEditMode = false;
  const hint = document.getElementById('vrRegionsHint');
  if (hint) hint.hidden = true;
  if (editRegionsBtn) editRegionsBtn.classList.remove('active');
  renderImages();
}

function renderImages() {
  const imagesDiv = document.getElementById('vrImages');
  const { baselineB64, currentB64, diffDataUrl, viewMode, ignoreRegions } = activeData();
  document.querySelectorAll('.vr-view-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === viewMode);
    // Only Baseline is available until a comparison has produced the others.
    b.disabled = b.dataset.view !== 'baseline' && !diffDataUrl;
  });

  if (!baselineB64) {
    imagesDiv.innerHTML = '<div class="vr-hint">Capture a baseline screenshot, interact with the page, then click Compare.</div>';
    return;
  }

  const col = (label, src) =>
    `<div class="vr-col"><div class="vr-col-label">${label}</div><img class="vr-img" src="${src}" /></div>`;
  const png = (b64) => `data:image/png;base64,${b64}`;

  if (viewMode === 'compare' && diffDataUrl) {
    imagesDiv.classList.remove('vr-single');
    imagesDiv.innerHTML =
      col('Baseline', png(baselineB64)) + col('Current', png(currentB64)) + col('Diff', diffDataUrl);
    return;
  }

  imagesDiv.classList.add('vr-single');
  if (viewMode === 'current' && currentB64)  { imagesDiv.innerHTML = col('Current', png(currentB64)); return; }
  if (viewMode === 'diff' && diffDataUrl)    { imagesDiv.innerHTML = col('Diff', diffDataUrl); return; }

  // Baseline view — the only one that shows the ignore-region overlay
  // (view-only unless regionsEditMode is on), since regions are always
  // drawn against the baseline image's own coordinate space.
  imagesDiv.innerHTML = `<div class="vr-col"><div class="vr-col-label">Baseline</div>
    <div class="vr-img-wrap" id="vrBaselineWrap">
      <img class="vr-img" id="vrBaselineImg" src="${png(baselineB64)}" />
      <canvas class="vr-regions-canvas" id="vrRegionsCanvas"></canvas>
    </div></div>`;
  setupRegionsOverlay(ignoreRegions);
}

// ─── Ignore regions (#277) ──────────────────────────────────────────────────
// Drawn directly on the baseline image, tracked in image-pixel coordinates
// (not display coordinates) so a region stays correctly placed regardless of
// how the panel currently scales the image. Editing is gated behind an
// explicit "Edit ignore regions" toggle so a normal click on the baseline
// image (e.g. to focus the panel) never accidentally draws a region.
let regionsEditMode = false;

function toggleRegionsEditMode() {
  regionsEditMode = !regionsEditMode;
  document.getElementById('vrRegionsHint').hidden = !regionsEditMode;
  document.getElementById('vrEditRegionsBtn').classList.toggle('active', regionsEditMode);
  if (activeData().viewMode !== 'baseline') activeData().viewMode = 'baseline';
  renderImages();
}

function persistIgnoreRegionsIfSaved() {
  const d = activeData();
  // Only a *saved* baseline has anywhere to persist regions to — an
  // in-memory-only capture just keeps them in sessionData until Save as…
  // is used, at which point saveActiveBaseline() sends the whole set.
  if (d.baselineId) testerBrowser.visualRegression.setIgnoreRegions(d.baselineId, d.ignoreRegions);
}

function setupRegionsOverlay() {
  const img = document.getElementById('vrBaselineImg');
  const canvas = document.getElementById('vrRegionsCanvas');
  if (!img || !canvas) return;

  const draw = () => {
    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scaleX = img.clientWidth / (img.naturalWidth || 1);
    const scaleY = img.clientHeight / (img.naturalHeight || 1);
    ctx.fillStyle = 'rgba(140,140,140,0.45)';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    for (const r of activeData().ignoreRegions) {
      ctx.fillRect(r.x * scaleX, r.y * scaleY, r.w * scaleX, r.h * scaleY);
      ctx.strokeRect(r.x * scaleX, r.y * scaleY, r.w * scaleX, r.h * scaleY);
    }
  };

  if (img.complete) draw(); else img.addEventListener('load', draw, { once: true });
  canvas.classList.toggle('vr-regions-editable', regionsEditMode);
  canvas.onmousedown = null;
  canvas.onmousemove = null;
  canvas.onmouseup = null;
  canvas.onmouseleave = null;
  if (!regionsEditMode) return;

  let dragStart = null;

  const toImageCoords = (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = (img.naturalWidth || 1) / img.clientWidth;
    const scaleY = (img.naturalHeight || 1) / img.clientHeight;
    return { x: Math.round((e.clientX - rect.left) * scaleX), y: Math.round((e.clientY - rect.top) * scaleY) };
  };

  canvas.onmousedown = (e) => { dragStart = toImageCoords(e); };

  canvas.onmousemove = (e) => {
    if (!dragStart) return;
    const cur = toImageCoords(e);
    draw();
    const ctx = canvas.getContext('2d');
    const scaleX = img.clientWidth / (img.naturalWidth || 1);
    const scaleY = img.clientHeight / (img.naturalHeight || 1);
    const x = Math.min(dragStart.x, cur.x) * scaleX;
    const y = Math.min(dragStart.y, cur.y) * scaleY;
    ctx.fillStyle = 'rgba(79,195,247,0.35)';
    ctx.strokeStyle = 'rgba(79,195,247,0.9)';
    ctx.fillRect(x, y, Math.abs(cur.x - dragStart.x) * scaleX, Math.abs(cur.y - dragStart.y) * scaleY);
    ctx.strokeRect(x, y, Math.abs(cur.x - dragStart.x) * scaleX, Math.abs(cur.y - dragStart.y) * scaleY);
  };

  canvas.onmouseup = (e) => {
    if (!dragStart) return;
    const end = toImageCoords(e);
    const start = dragStart;
    dragStart = null;

    // A near-zero drag reads as a click on an existing region instead of
    // an attempt to draw a new (degenerate) one.
    if (Math.hypot(end.x - start.x, end.y - start.y) < 4) {
      const regions = activeData().ignoreRegions;
      const idx = regions.findIndex((r) => end.x >= r.x && end.x < r.x + r.w && end.y >= r.y && end.y < r.y + r.h);
      if (idx >= 0) { regions.splice(idx, 1); persistIgnoreRegionsIfSaved(); }
      draw();
      return;
    }

    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    if (w >= 2 && h >= 2) {
      activeData().ignoreRegions.push({ x, y, w, h });
      persistIgnoreRegionsIfSaved();
    }
    draw();
  };

  canvas.onmouseleave = () => { dragStart = null; draw(); };
}

async function captureBaseline() {
  if (!getActiveId()) return;
  const sessionId   = getActiveId();
  const captureBtn  = document.getElementById('vrCaptureBtn');
  const compareBtn  = document.getElementById('vrCompareBtn');
  const stats       = document.getElementById('vrStats');

  captureBtn.disabled = true;
  captureBtn.textContent = 'Capturing…';
  stats.textContent = '';

  const b64 = await testerBrowser.visualRegression.captureScreenshot(sessionId, { fullPage: isFullPage() });
  captureBtn.disabled = false;
  captureBtn.textContent = 'Capture baseline';

  // The user may have switched sessions while the screenshot was in flight.
  if (sessionId !== getActiveId()) return;
  if (!b64) { stats.textContent = 'Screenshot failed.'; return; }

  // A fresh baseline invalidates any previous comparison for this session,
  // and — since it's pixel-different from whatever saved baseline (if any)
  // was previously loaded — its own saved identity and ignore regions too;
  // it's no longer backed by that file until explicitly saved again.
  const d = activeData();
  d.baselineB64 = b64;
  d.baselineId  = null;
  d.currentB64  = null;
  d.diffDataUrl = null;
  d.viewMode    = 'baseline';
  d.ignoreRegions = [];
  compareBtn.disabled = false;
  document.getElementById('vrSaveBaselineBtn').disabled = false;
  document.getElementById('vrEditRegionsBtn').disabled = false;
  renderImages();
  stats.textContent = 'Baseline captured. Interact with the page, then click Compare.';
}

async function runCompare() {
  const sessionId = getActiveId();
  const { baselineB64, compareSessionId, threshold, ignoreRegions } = activeData();
  if (!sessionId || !baselineB64) return;
  // Defaults to the baseline's own session (this feature's original,
  // single-session behavior) unless the user picked a different one to
  // capture the "current" screenshot from — see #127.
  const targetId = compareSessionId || sessionId;
  const compareBtn = document.getElementById('vrCompareBtn');
  const stats      = document.getElementById('vrStats');

  compareBtn.disabled = true;
  compareBtn.textContent = 'Comparing…';
  stats.textContent = '';

  try {
    const captured = await testerBrowser.visualRegression.captureScreenshot(targetId, { fullPage: isFullPage() });
    if (sessionId !== getActiveId()) return;
    if (!captured) { stats.textContent = 'Screenshot failed — the selected session may have been closed.'; return; }

    const [baseImg, curImg] = await Promise.all([
      loadImage(baselineB64).catch(() => { throw new Error('could not decode baseline screenshot'); }),
      loadImage(captured).catch(() => { throw new Error('could not decode current screenshot'); }),
    ]);

    const w = Math.max(baseImg.width,  curImg.width);
    const h = Math.max(baseImg.height, curImg.height);
    const sizeMismatch = baseImg.width !== curImg.width || baseImg.height !== curImg.height;

    const { diffDataUrl, diffCount, total } = await computeDiffInWorker(baseImg, curImg, w, h, threshold, ignoreRegions);
    const pct = total > 0 ? ((diffCount / total) * 100).toFixed(2) : '0.00';

    const d = activeData();
    d.currentB64  = captured;
    d.diffDataUrl = diffDataUrl;
    d.viewMode    = 'diff';
    renderImages();

    const warning = sizeMismatch
      ? ` ⚠ Image sizes differ: baseline ${baseImg.width}×${baseImg.height}, current ${curImg.width}×${curImg.height} — comparison may be misleading.`
      : '';
    stats.textContent = `${diffCount.toLocaleString()} pixels differ (${pct}% of ${total.toLocaleString()})${warning}`;
  } catch (err) {
    stats.textContent = `Compare failed: ${err.message}`;
  } finally {
    compareBtn.disabled = false;
    compareBtn.textContent = 'Compare';
  }
}

function isFullPage() {
  return document.getElementById('vrFullPage').checked;
}

// Rejects on a decode failure (corrupt/truncated base64, an unsupported
// format) instead of leaving the Promise permanently unsettled — that used
// to hang runCompare's await forever, with the Compare button stuck on
// "Comparing…" until the tab or app restarted (#238).
function loadImage(b64) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to decode'));
    img.src = `data:image/png;base64,${b64}`;
  });
}

// Decodes both images onto same-size canvases on the main thread (Image()/
// OffscreenCanvas.drawImage need a real image-decoding path, not available
// inside a Worker), then hands the two raw RGBA buffers to vr-worker.js —
// transferred, not copied, so a large full-page capture doesn't double its
// memory cost — for the actual per-pixel comparison loop. That loop is the
// part that can run to tens of millions of iterations and freeze the UI
// thread; moving just it into a Worker keeps the app responsive during a
// large compare (#238).
function computeDiffInWorker(img1, img2, w, h, threshold, regions) {
  const c1 = new OffscreenCanvas(w, h);
  const c2 = new OffscreenCanvas(w, h);
  const x1 = c1.getContext('2d');
  const x2 = c2.getContext('2d');
  x1.drawImage(img1, 0, 0);
  x2.drawImage(img2, 0, 0);
  const d1 = x1.getImageData(0, 0, w, h).data;
  const d2 = x2.getImageData(0, 0, w, h).data;

  return new Promise((resolve, reject) => {
    const worker = getVrWorker();
    const onMessage = (e) => {
      cleanup();
      const { diffData, diffCount, total } = e.data;
      const cd = document.createElement('canvas');
      cd.width = w;
      cd.height = h;
      cd.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(diffData), w, h), 0, 0);
      resolve({ diffDataUrl: cd.toDataURL('image/png'), diffCount, total });
    };
    const onError = () => { cleanup(); reject(new Error('diff computation failed')); };
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ w, h, buf1: d1.buffer, buf2: d2.buffer, threshold, regions }, [d1.buffer, d2.buffer]);
  });
}

// ─── Saved baselines (#277) ─────────────────────────────────────────────────
// Persisted main-process side (userData/baselines/) so a baseline survives
// past the tab that captured it, and past a restart — unlike the rest of
// this feature's sessionData, which is purely in-memory per tab.

async function refreshBaselinesList() {
  const pick = document.getElementById('vrBaselinePick');
  if (!pick) return;
  const baselines = await testerBrowser.visualRegression.listBaselines();
  const current = pick.value;
  pick.innerHTML = '<option value="">— saved baselines —</option>' +
    baselines.map((b) => `<option value="${b.id}">${escHtml(b.name)} (${new Date(b.capturedAt).toLocaleDateString()})</option>`).join('');
  pick.value = baselines.some((b) => b.id === current) ? current : '';
  const hasSelection = !!pick.value;
  document.getElementById('vrLoadBaselineBtn').disabled = !hasSelection;
  document.getElementById('vrExportBaselineBtn').disabled = !hasSelection;
  document.getElementById('vrDeleteBaselineBtn').disabled = !hasSelection;
}

async function loadSelectedBaseline() {
  const id = document.getElementById('vrBaselinePick').value;
  if (!id) return;
  const statusEl = document.getElementById('vrBaselineStatus');
  const entry = await testerBrowser.visualRegression.getBaseline(id);
  if (!entry) { statusEl.textContent = 'Could not load that baseline.'; return; }

  const d = activeData();
  d.baselineB64   = entry.b64;
  d.baselineId    = id;
  d.currentB64    = null;
  d.diffDataUrl   = null;
  d.viewMode      = 'baseline';
  d.ignoreRegions = entry.meta.ignoreRegions || [];
  regionsEditMode = false;
  document.getElementById('vrRegionsHint').hidden = true;
  document.getElementById('vrEditRegionsBtn').classList.remove('active');
  statusEl.textContent = `Loaded "${entry.meta.name}".`;
  refreshVR();
}

// prompt()/confirm() with a real return value would be simplest here, but
// prompt() is blocked outright in this app's renderer (contextIsolation) —
// silently returns null. An inline modal (same shell as record-playback.js's
// assertion dialog) is the established substitute.
function promptBaselineName(defaultValue) {
  return new Promise((resolve) => {
    document.getElementById('vrSaveDlg')?.remove();
    const dlg = document.createElement('div');
    dlg.id = 'vrSaveDlg';
    dlg.className = 'rp-assert-dlg';
    dlg.innerHTML = `
      <div class="rp-assert-dlg-inner">
        <div class="rp-assert-dlg-title">Save baseline as…</div>
        <input class="rp-input" id="vrSaveNameInput" value="${escHtml(defaultValue)}" />
        <div class="rp-assert-dlg-btns">
          <button class="rp-btn" id="vrSaveDlgOk">Save</button>
          <button class="rp-btn" id="vrSaveDlgCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    const input = document.getElementById('vrSaveNameInput');
    input.focus();
    input.select();
    const cleanup = () => dlg.remove();
    const ok = () => { const v = input.value.trim(); cleanup(); resolve(v || null); };
    document.getElementById('vrSaveDlgOk').addEventListener('click', ok);
    document.getElementById('vrSaveDlgCancel').addEventListener('click', () => { cleanup(); resolve(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
      if (e.key === 'Escape') { cleanup(); resolve(null); }
    });
  });
}

async function saveActiveBaseline() {
  const d = activeData();
  if (!d.baselineB64) return;
  const statusEl = document.getElementById('vrBaselineStatus');

  const sessions = await testerBrowser.sessions.list();
  const url = sessions.find((s) => s.id === getActiveId())?.url || '';
  const defaultName = url ? `${url} — ${new Date().toLocaleString()}` : `Baseline — ${new Date().toLocaleString()}`;
  const name = await promptBaselineName(defaultName);
  if (!name) return;

  const meta = await testerBrowser.visualRegression.saveBaseline(name, url, d.baselineB64);
  if (!meta) { statusEl.textContent = 'Failed to save baseline.'; return; }
  d.baselineId = meta.id;
  if (d.ignoreRegions.length) {
    await testerBrowser.visualRegression.setIgnoreRegions(meta.id, d.ignoreRegions);
  }
  statusEl.textContent = `Saved as "${name}".`;
  await refreshBaselinesList();
  document.getElementById('vrBaselinePick').value = meta.id;
  document.getElementById('vrLoadBaselineBtn').disabled = false;
  document.getElementById('vrExportBaselineBtn').disabled = false;
  document.getElementById('vrDeleteBaselineBtn').disabled = false;
}

async function exportSelectedBaseline() {
  const id = document.getElementById('vrBaselinePick').value;
  if (!id) return;
  const statusEl = document.getElementById('vrBaselineStatus');
  const result = await testerBrowser.visualRegression.exportBaseline(id);
  if (result.canceled) { statusEl.textContent = ''; return; }
  statusEl.textContent = result.ok
    ? `Exported to ${result.path.split(/[\\/]/).pop()}`
    : (result.error || 'Export failed');
}

async function importBaseline() {
  const statusEl = document.getElementById('vrBaselineStatus');
  const result = await testerBrowser.visualRegression.importBaseline();
  if (result.canceled) { statusEl.textContent = ''; return; }
  if (!result.ok) { statusEl.textContent = result.error || 'Import failed'; return; }
  statusEl.textContent = `Imported "${result.imported.name}".`;
  await refreshBaselinesList();
}

async function deleteSelectedBaseline() {
  const id = document.getElementById('vrBaselinePick').value;
  if (!id) return;
  await testerBrowser.visualRegression.deleteBaseline(id);
  // Stays loaded in the panel if it was the active baseline — just no
  // longer backed by a saved file (same as a freshly captured one).
  const d = activeData();
  if (d.baselineId === id) d.baselineId = null;
  document.getElementById('vrBaselineStatus').textContent = 'Baseline deleted.';
  await refreshBaselinesList();
}
