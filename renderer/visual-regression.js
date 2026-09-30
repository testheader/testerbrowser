/* global testerBrowser */
import { getActiveId } from './tabs.js';
import { buildSessionOptions } from './session-picker.js';
import { escHtml } from './utils.js';
import {
  normalizeViewMode, normalizeZoom, scaleForZoom, stepZoom, formatZoom, ZOOM_STEPS,
  zoomToShowRegion, scrollToCenter, nextIndex, formatPct, parseMaxDiffPct, compareVerdict,
  DEFAULT_THRESHOLD, MAX_THRESHOLD, parseThreshold, thresholdHint,
  rectFromPoints, clampRegion, regionIndexAt, regionsCoverage, describeRegion,
  filterBaselines, stepState,
} from './vr-logic.js';

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
// just-saved, or loaded from the saved-baselines list) — null for one freshly
// captured in this tab but never saved. ignoreRegions are the working set
// for the active baseline (image-pixel {x,y,w,h} rectangles); edits while
// baselineId is set persist immediately via setIgnoreRegions so they're
// remembered next time that saved baseline is used, per the ticket.
//
// Per session: { baselineB64, baselineId, baselineInfo: { name, url, capturedAt, w, h, source },
//   currentB64, diffDataUrl, result, stale, activeRegion, message, messageIsError,
//   viewMode, compareSessionId, threshold, ignoreRegions }
const sessionData = new Map();

export function clearVRSession(sessionId) {
  sessionData.delete(sessionId);
}

// Viewer preferences are global (not per tab) and remembered across restarts.
const LS_VIEW = 'vrViewMode';
const LS_ZOOM = 'vrZoom';
const LS_MAX_DIFF = 'vrMaxDiffPct';
function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }

let preferredView = 'diff';
let zoom = 'fit';
let maxDiffPct = 0;
let overlayPos = 50;
let lastScale = 1;
let regionsEditMode = false;
let highlightedIgnoreIdx = -1;
let savedBaselines = [];
let baselinesOpen = false;
let pendingDeleteId = null;
const thumbCache = new Map(); // baseline id -> thumbnail data URL, or '' when it failed
let thumbQueueRunning = false;

function emptyData() {
  return {
    baselineB64: null, baselineId: null, baselineInfo: null,
    currentB64: null, diffDataUrl: null, result: null, stale: false, activeRegion: -1,
    message: '', messageIsError: false,
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

const $ = (id) => document.getElementById(id);
const png = (b64) => `data:image/png;base64,${b64}`;

const VIEW_BUTTONS = [
  ['baseline', 'Baseline', 'The baseline screenshot on its own — draw ignore regions here'],
  ['side', 'Side by side', 'Baseline and current screenshot next to each other'],
  ['overlay', 'Overlay', 'Current screenshot laid over the baseline, with a slider to reveal either'],
  ['diff', 'Diff', 'Only the changed pixels, highlighted in red; ignored areas in grey'],
];

export function initVR() {
  const panel = $('vrPanel');
  if (panel.dataset.initialized) return;
  panel.dataset.initialized = '1';

  preferredView = normalizeViewMode(lsGet(LS_VIEW));
  zoom = normalizeZoom(lsGet(LS_ZOOM));
  maxDiffPct = parseMaxDiffPct(lsGet(LS_MAX_DIFF));

  const step = (n, title) => `<span class="vr-step" id="vrStep${n}"><span class="vr-step-num" aria-hidden="true">${n}</span>` +
    `<span class="diff-sr">Step ${n}: </span>${title}<span class="diff-sr" data-step-state></span></span>`;

  panel.innerHTML = `
    <div class="vr-toolbar">
      <div class="vr-toolbar-row vr-steps" role="group" aria-label="Comparison steps">
        ${step(1, 'Baseline')}
        <button type="button" class="vr-btn" id="vrCaptureBtn" title="Screenshot the active tab as the reference to compare against">Capture baseline</button>
        <button type="button" class="vr-btn" id="vrBaselinesToggle" aria-expanded="false" aria-controls="vrBaselines"
          title="Pick, rename, export or delete a saved baseline">Saved baselines<span class="vr-count" id="vrBaselineCount"></span></button>
        <span class="vr-step-sep" aria-hidden="true">›</span>
        ${step(2, 'Current page')}
        <label class="diff-label" title="Tab to capture the 'current' screenshot from when comparing">from
          <select class="diff-pick" id="vrComparePick"></select>
        </label>
        <label class="vr-toggle" title="Capture the whole scrollable page instead of just the viewport (baseline and current)">
          <input type="checkbox" id="vrFullPage" /> Full page
        </label>
        <span class="vr-step-sep" aria-hidden="true">›</span>
        ${step(3, 'Compare')}
        <button type="button" class="vr-btn vr-primary" id="vrCompareBtn" disabled
          title="Capture the current page and compare it with the baseline">Compare</button>
      </div>
      <div class="vr-toolbar-row">
        <span class="vr-toolbar-label" id="vrBaselineLabel">Baseline</span>
        <span class="panel-chip vr-baseline-chip" id="vrBaselineChip">None yet</span>
        <button type="button" class="vr-btn" id="vrSaveBaselineBtn" disabled title="Save the current baseline screenshot for reuse across tabs and restarts">Save as…</button>
        <button type="button" class="vr-btn" id="vrImportBaselineBtn" title="Import a baseline (PNG + sidecar JSON) exported from this or another machine">Import…</button>
        <span class="status-msg" id="vrBaselineStatus" role="status" aria-live="polite"></span>
      </div>
      <div class="vr-toolbar-row">
        <span class="vr-toolbar-label">Rules</span>
        <label class="diff-label" for="vrThreshold">Colour tolerance</label>
        <input type="number" id="vrThreshold" min="0" max="${MAX_THRESHOLD}" value="${DEFAULT_THRESHOLD}" class="vr-threshold-input"
          aria-describedby="vrThresholdHint"
          title="Per-pixel colour difference (R+G+B summed, 0–${MAX_THRESHOLD}) above which a pixel counts as changed. Higher = more lenient." />
        <span class="vr-hint-inline" id="vrThresholdHint"></span>
        <label class="diff-label" for="vrMaxDiff">Pass if at most</label>
        <input type="number" id="vrMaxDiff" min="0" max="100" step="0.01" class="vr-threshold-input" aria-describedby="vrMaxDiffUnit" />
        <span class="diff-label" id="vrMaxDiffUnit">% of pixels changed</span>
        <button type="button" class="vr-btn" id="vrEditRegionsBtn" disabled aria-pressed="false"
          title="Draw rectangles on the baseline that are left out of the comparison (clocks, ads, animations)">Edit ignore regions</button>
      </div>
    </div>
    <div class="vr-baselines" id="vrBaselines" role="region" aria-label="Saved baselines" hidden>
      <div class="vr-bl-head">
        <input type="search" class="diff-filter-text" id="vrBaselineSearch" placeholder="Filter by name or URL" aria-label="Filter saved baselines" />
        <span class="status-msg" id="vrBaselineFilterNote" aria-live="polite"></span>
      </div>
      <ul class="vr-bl-list" id="vrBaselineList"></ul>
    </div>
    <div class="vr-ignore-bar" id="vrIgnoreBar" role="group" aria-labelledby="vrIgnoreLabel" hidden>
      <span class="vr-toolbar-label" id="vrIgnoreLabel">Ignored</span>
      <ul class="diff-ignore-chips" id="vrIgnoreList" aria-labelledby="vrIgnoreLabel"></ul>
      <button type="button" class="diff-link-btn" id="vrIgnoreClearBtn">Remove all</button>
      <span class="vr-hint-inline" id="vrIgnoreNote"></span>
      <span class="vr-hint-inline vr-edit-hint" id="vrRegionsHint" hidden>Drag on the baseline to add a region · click a region to remove it</span>
    </div>
    <div class="vr-summary" id="vrSummary">
      <span class="vr-verdict" id="vrVerdict" hidden></span>
      <span class="vr-stats" id="vrStats" role="status" aria-live="polite"></span>
      <ul class="diff-counts vr-sum-chips" id="vrSumChips"></ul>
      <div class="diff-meta vr-meta" id="vrMeta"></div>
    </div>
    <div class="vr-viewbar" id="vrViewbar" hidden>
      <span class="vr-toolbar-label" id="vrViewLabel">View</span>
      <div class="vr-views" id="vrViews" role="group" aria-labelledby="vrViewLabel">
        ${VIEW_BUTTONS.map(([v, label, title]) =>
          `<button type="button" class="vr-btn vr-view-btn" data-view="${v}" aria-pressed="false" title="${title}">${label}</button>`).join('')}
      </div>
      <div class="vr-zoom" role="group" aria-label="Zoom">
        <button type="button" class="vr-btn vr-icon-btn" id="vrZoomOut" aria-label="Zoom out" aria-keyshortcuts="-" title="Zoom out (−)">−</button>
        <select class="diff-pick" id="vrZoom" aria-label="Zoom level">
          <option value="fit">Fit</option>
          <option value="width">Fit width</option>
          ${ZOOM_STEPS.map((z) => `<option value="${z}">${formatZoom(z)}</option>`).join('')}
        </select>
        <button type="button" class="vr-btn vr-icon-btn" id="vrZoomIn" aria-label="Zoom in" aria-keyshortcuts="+" title="Zoom in (+)">+</button>
        <span class="vr-hint-inline" id="vrZoomNow" aria-live="polite"></span>
      </div>
      <div class="vr-nav" id="vrNav" role="group" aria-label="Changed regions">
        <button type="button" class="vr-btn" id="vrPrevRegion" aria-keyshortcuts="P" title="Previous changed region (P)" disabled>‹ Prev</button>
        <span class="vr-region-pos" id="vrRegionPos" aria-live="polite"></span>
        <button type="button" class="vr-btn" id="vrNextRegion" aria-keyshortcuts="N" title="Next changed region (N)" disabled>Next ›</button>
      </div>
    </div>
    <div class="vr-images" id="vrImages" role="region" aria-label="Screenshots" tabindex="0"></div>`;

  $('vrCaptureBtn').addEventListener('click', captureBaseline);
  $('vrCompareBtn').addEventListener('click', runCompare);
  $('vrViews').addEventListener('click', (e) => {
    const btn = e.target.closest('.vr-view-btn');
    if (!btn || btn.disabled) return;
    setViewMode(btn.dataset.view);
  });
  $('vrComparePick').addEventListener('change', (e) => {
    activeData().compareSessionId = e.target.value;
  });
  $('vrThreshold').addEventListener('input', (e) => {
    $('vrThresholdHint').textContent = thresholdHint(parseThreshold(e.target.value));
  });
  $('vrThreshold').addEventListener('change', (e) => {
    const d = activeData();
    const next = parseThreshold(e.target.value);
    e.target.value = String(next);
    if (next !== d.threshold) {
      d.threshold = next;
      markStale();
    }
    $('vrThresholdHint').textContent = thresholdHint(next);
  });
  $('vrMaxDiff').value = String(maxDiffPct);
  $('vrMaxDiff').addEventListener('change', (e) => {
    maxDiffPct = parseMaxDiffPct(e.target.value);
    e.target.value = String(maxDiffPct);
    lsSet(LS_MAX_DIFF, String(maxDiffPct));
    renderSummary();
  });
  $('vrEditRegionsBtn').addEventListener('click', toggleRegionsEditMode);
  $('vrSaveBaselineBtn').addEventListener('click', saveActiveBaseline);
  $('vrImportBaselineBtn').addEventListener('click', importBaseline);
  $('vrBaselinesToggle').addEventListener('click', () => setBaselinesOpen(!baselinesOpen));
  $('vrBaselineSearch').addEventListener('input', renderBaselineList);
  $('vrBaselineList').addEventListener('click', onBaselineListClick);
  $('vrIgnoreList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-region]');
    if (btn) removeIgnoreRegion(Number(btn.dataset.removeRegion));
  });
  const highlightFrom = (e) => {
    const chip = e.target.closest('[data-region-idx]');
    const idx = chip ? Number(chip.dataset.regionIdx) : -1;
    if (idx !== highlightedIgnoreIdx) { highlightedIgnoreIdx = idx; drawOverlays(); }
  };
  $('vrIgnoreList').addEventListener('mouseover', highlightFrom);
  $('vrIgnoreList').addEventListener('focusin', highlightFrom);
  $('vrIgnoreList').addEventListener('mouseleave', () => { highlightedIgnoreIdx = -1; drawOverlays(); });
  $('vrIgnoreList').addEventListener('focusout', () => { highlightedIgnoreIdx = -1; drawOverlays(); });
  $('vrIgnoreClearBtn').addEventListener('click', () => {
    const d = activeData();
    if (!d.ignoreRegions.length) return;
    d.ignoreRegions = [];
    persistIgnoreRegionsIfSaved();
    markStale();
    renderIgnoreBar();
    drawOverlays();
  });
  $('vrSumChips').addEventListener('click', (e) => {
    if (e.target.closest('#vrRecomputeBtn')) recomputeFromStored();
  });

  $('vrZoom').addEventListener('change', (e) => setZoom(normalizeZoom(e.target.value)));
  $('vrZoomIn').addEventListener('click', () => setZoom(stepZoom(lastScale, 1)));
  $('vrZoomOut').addEventListener('click', () => setZoom(stepZoom(lastScale, -1)));
  $('vrPrevRegion').addEventListener('click', () => goToRegion(-1));
  $('vrNextRegion').addEventListener('click', () => goToRegion(1));

  panel.addEventListener('keydown', onPanelKeydown);
  // Fit modes depend on the viewer's size — re-lay out when it changes
  // (console panel resized, window resized, the tab first shown).
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (typeof zoom !== 'number') applyLayout(); }).observe($('vrImages'));
  }

  refreshBaselinesList();
  refreshVRComparePicker();
}

// Repopulates the "Compare against" session picker. Called on init and
// whenever the session list changes (new/closed/renamed tabs), independent
// of whether the VR tab is currently visible — so the list is current
// whenever the user opens it, without disturbing an in-progress comparison
// the way a full refreshVR() (which resets stats/view) would.
export async function refreshVRComparePicker() {
  const pick = $('vrComparePick');
  if (!pick) return; // panel not initialized yet

  const sessions = await testerBrowser.sessions.list();
  const current = pick.value;
  buildSessionOptions(pick, sessions, { extraFirstOption: { value: '', label: 'This tab (same as baseline)' } });

  const stillValid = current && sessions.some(s => s.id === current);
  pick.value = stillValid ? current : '';
  activeData().compareSessionId = pick.value;
}

// Re-render the panel for the currently active session — called on init and
// whenever the user switches sessions, so a baseline never silently gets
// compared against a different session's page.
export function refreshVR() {
  if (!$('vrCompareBtn')) return; // panel not initialized yet
  const d = activeData();
  // The picker is one shared element — resync its displayed value to the
  // newly-active session's own stored preference, not whatever was left
  // showing for the previously active session.
  $('vrComparePick').value = d.compareSessionId || '';
  $('vrThreshold').value = String(d.threshold);
  $('vrThresholdHint').textContent = thresholdHint(d.threshold);
  // Switching sessions leaves regions-edit mode — it's tied to whichever
  // session's baseline is on screen, and following the active session into
  // it unannounced would let a drag meant for one baseline edit another's.
  setRegionsEditMode(false);
  renderAll();
}

function renderAll() {
  const d = activeData();
  $('vrCompareBtn').disabled = !d.baselineB64;
  $('vrEditRegionsBtn').disabled = !d.baselineB64;
  $('vrSaveBaselineBtn').disabled = !d.baselineB64;
  renderSteps();
  renderBaselineChip();
  renderIgnoreBar();
  renderSummary();
  renderImages();
  if (baselinesOpen) renderBaselineList();
}

function renderSteps() {
  const d = activeData();
  const { done, current } = stepState({ hasBaseline: !!d.baselineB64, hasResult: !!d.result });
  [1, 2, 3].forEach((n) => {
    const el = $(`vrStep${n}`);
    const isCurrent = current === n || (current === 2 && n === 3);
    el.classList.toggle('done', done[n - 1]);
    el.classList.toggle('current', isCurrent);
    el.querySelector('[data-step-state]').textContent = done[n - 1] ? ' (done)' : isCurrent ? ' (next)' : '';
  });
  $('vrCompareBtn').classList.toggle('vr-primary-ready', !!d.baselineB64);
}

function renderBaselineChip() {
  const d = activeData();
  const chip = $('vrBaselineChip');
  const info = d.baselineInfo;
  if (!d.baselineB64 || !info) {
    chip.textContent = 'None yet';
    chip.title = '';
    chip.classList.add('vr-chip-empty');
    return;
  }
  chip.classList.remove('vr-chip-empty');
  const name = d.baselineId && info.name ? info.name : 'Unsaved capture';
  chip.textContent = `${name} · ${info.w}×${info.h}`;
  chip.title = [name, info.url, new Date(info.capturedAt).toLocaleString()].filter(Boolean).join('\n');
}

// ─── Status line + summary ──────────────────────────────────────────────────

// A progress message ("Capturing…") is cleared when its operation ends, even
// if the tester switched tabs meanwhile — it must never outlive the work.
function clearProgress(sessionId, msg) {
  const d = sessionData.get(sessionId);
  if (!d || d.message !== msg) return;
  d.message = '';
  if (sessionId === getActiveId()) renderSummary();
}

function setMessage(msg, isError = false) {
  const d = activeData();
  d.message = msg;
  d.messageIsError = isError;
  renderSummary();
}

function renderSummary() {
  const d = activeData();
  const r = d.result;
  const stats = $('vrStats');
  const verdictEl = $('vrVerdict');
  const chips = $('vrSumChips');
  const meta = $('vrMeta');
  stats.classList.toggle('status-msg-error', !!(d.message && d.messageIsError));

  if (d.message) {
    stats.textContent = d.message;
  } else if (!d.baselineB64) {
    stats.textContent = 'Start with step 1: capture a baseline of this page, or pick one from Saved baselines.';
  } else if (!r) {
    stats.textContent = d.baselineInfo?.source === 'capture'
      ? 'Baseline captured. Interact with the page (or pick another tab under Current page), then click Compare.'
      : 'Baseline ready. Get the page into the state to check (or pick another tab under Current page), then click Compare.';
  } else {
    const pct = formatPct(r.diffCount, r.total);
    let text = `${r.diffCount.toLocaleString()} pixels differ (${pct}% of ${r.total.toLocaleString()})`;
    if (r.sizeMismatch) {
      text += ` ⚠ Image sizes differ: baseline ${r.baseW}×${r.baseH}, current ${r.curW}×${r.curH} — comparison may be misleading.`;
    }
    if (r.diffCount === 0) text += ' — no differences found at this colour tolerance.';
    stats.textContent = text;
  }

  if (!r) {
    verdictEl.hidden = true;
    chips.innerHTML = '';
    meta.textContent = '';
    return;
  }

  const v = compareVerdict(r, maxDiffPct);
  verdictEl.hidden = false;
  verdictEl.className = `vr-verdict ${v.pass ? 'pass' : 'fail'}`;
  verdictEl.textContent = v.pass ? '✓ Pass' : '✕ Fail';
  verdictEl.title = v.reason;
  verdictEl.setAttribute('aria-label', `${v.label}: ${v.reason}`);

  const regionCount = r.changedRegions.length;
  const parts = [];
  parts.push(`<li class="diff-sum ${regionCount ? 'changed' : 'unchanged'}"><b>${regionCount}${r.truncated ? '+' : ''}</b> changed region${regionCount === 1 ? '' : 's'}</li>`);
  if (r.ignoredPx > 0) {
    parts.push(`<li class="diff-sum total" title="Pixels inside ignore regions are left out of both the changed count and the total"><b>${r.ignoredCount}</b> ignore region${r.ignoredCount === 1 ? '' : 's'} · ${r.ignoredPx.toLocaleString()} px excluded from the %</li>`);
  }
  if (r.sizeMismatch) {
    parts.push('<li class="diff-sum added">⚠ Sizes differ</li>');
  }
  if (d.stale) {
    parts.push('<li class="diff-sum added vr-stale">Settings changed since this compare ' +
      '<button type="button" class="diff-small-btn" id="vrRecomputeBtn" title="Re-run the comparison on the same two screenshots with the new tolerance and ignore regions">Update result</button></li>');
  }
  chips.innerHTML = parts.join('');

  const info = d.baselineInfo || {};
  const baseName = d.baselineId && info.name ? info.name : 'unsaved capture';
  meta.innerHTML = `Baseline <b>${escHtml(baseName)}</b>` +
    (info.capturedAt ? ` · captured ${escHtml(new Date(info.capturedAt).toLocaleString())}` : '') +
    (info.url ? ` · <span class="vr-meta-url" title="${escHtml(info.url)}">${escHtml(info.url)}</span>` : '') +
    ` → compared with <b>${escHtml(r.compareLabel)}</b> at ${escHtml(new Date(r.comparedAt).toLocaleTimeString())}` +
    ` · tolerance ${r.threshold}`;
}

// Tolerance or ignore-region edits after a compare leave its numbers out of
// date — say so (with a one-click re-run) instead of silently mismatching.
function markStale() {
  const d = activeData();
  if (!d.result) return;
  d.stale = true;
  renderSummary();
}

// ─── View modes, zoom, layout ───────────────────────────────────────────────

function setViewMode(mode) {
  const d = activeData();
  if (mode !== 'baseline' && !d.result) return;
  if (regionsEditMode && mode !== 'baseline') setRegionsEditMode(false);
  d.viewMode = mode;
  if (mode !== 'baseline') {
    preferredView = normalizeViewMode(mode);
    lsSet(LS_VIEW, preferredView);
  }
  renderImages();
}

function setZoom(z) {
  zoom = z;
  lsSet(LS_ZOOM, String(z));
  applyLayout();
}

function currentView() {
  const d = activeData();
  if (regionsEditMode || !d.result) return 'baseline';
  return d.viewMode;
}

function renderImages() {
  const stage = $('vrImages');
  const d = activeData();
  const view = currentView();

  $('vrViewbar').hidden = !d.baselineB64;
  document.querySelectorAll('.vr-view-btn').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
    // Only Baseline is available until a comparison has produced the others.
    b.disabled = b.dataset.view !== 'baseline' && !d.result;
  });
  renderRegionNav();

  if (!d.baselineB64) {
    stage.classList.remove('vr-stage-images');
    stage.innerHTML = `
      <div class="diff-empty vr-empty">
        <div class="diff-hint">No baseline yet</div>
        <ol class="diff-empty-steps">
          <li><b>Capture baseline</b> screenshots this tab as the reference — or open <b>Saved baselines</b> to reuse one.</li>
          <li>Change the page (deploy, toggle a feature, edit CSS) — or choose another tab under <b>Current page</b>, e.g. staging vs production.</li>
          <li><b>Compare</b> captures the current page and highlights every changed pixel, with a pass/fail against your limit.</li>
        </ol>
      </div>`;
    return;
  }
  stage.classList.add('vr-stage-images');

  const r = d.result;
  const imgTag = (id, src, w, h, alt) =>
    `<img class="vr-img" ${id ? `id="${id}"` : ''} src="${src}" data-w="${w}" data-h="${h}" alt="${escHtml(alt)}" draggable="false" />`;
  const col = (label, inner, extra = '') => `<figure class="vr-col${extra}"><figcaption class="vr-col-label">${label}</figcaption>${inner}</figure>`;
  const bw = d.baselineInfo.w;
  const bh = d.baselineInfo.h;

  if (view === 'side' && r) {
    stage.innerHTML = '<div class="vr-cols">' +
      col('Baseline', `<div class="vr-img-wrap" data-cw="${r.w}" data-ch="${r.h}">${imgTag('', png(d.baselineB64), bw, bh, 'Baseline screenshot')}<canvas class="vr-ov" aria-hidden="true"></canvas></div>`) +
      col('Current', `<div class="vr-img-wrap" data-cw="${r.w}" data-ch="${r.h}">${imgTag('', png(d.currentB64), r.curW, r.curH, 'Current screenshot')}<canvas class="vr-ov" aria-hidden="true"></canvas></div>`) +
      '</div>';
  } else if (view === 'overlay' && r) {
    stage.innerHTML = col(
      'Overlay — baseline on the left of the line, current on the right',
      `<div class="vr-img-wrap vr-overlay-wrap" id="vrOverlayWrap" data-cw="${r.w}" data-ch="${r.h}">
         ${imgTag('', png(d.baselineB64), bw, bh, 'Baseline screenshot')}
         <div class="vr-overlay-top" id="vrOverlayTop">${imgTag('', png(d.currentB64), r.curW, r.curH, 'Current screenshot')}</div>
         <div class="vr-overlay-line" id="vrOverlayLine" aria-hidden="true"></div>
         <canvas class="vr-ov" aria-hidden="true"></canvas>
       </div>
       <label class="vr-overlay-slider"><span>Baseline</span>
         <input type="range" id="vrOverlaySlider" min="0" max="100" step="1" value="${overlayPos}"
           aria-label="Overlay divider: baseline shows to the left, current to the right" aria-valuetext="${overlayPos}% baseline" />
         <span>Current</span></label>`,
      ' vr-col-single');
    wireOverlay();
  } else if (view === 'diff' && r) {
    stage.innerHTML = col('Diff — changed pixels in red, ignored areas in grey, the rest dimmed',
      `<div class="vr-img-wrap" data-cw="${r.w}" data-ch="${r.h}">${imgTag('', d.diffDataUrl, r.w, r.h, 'Difference image')}<canvas class="vr-ov" aria-hidden="true"></canvas></div>`,
      ' vr-col-single');
  } else {
    // Baseline view — the only one where ignore regions can be edited
    // (only while regionsEditMode is on), since regions are always drawn
    // against the baseline image's own coordinate space.
    stage.innerHTML = col(regionsEditMode ? 'Baseline — drag to add an ignore region, click one to remove it' : 'Baseline',
      `<div class="vr-img-wrap" id="vrBaselineWrap" data-cw="${bw}" data-ch="${bh}">
         ${imgTag('vrBaselineImg', png(d.baselineB64), bw, bh, 'Baseline screenshot')}
         <canvas class="vr-ov vr-regions-canvas" id="vrRegionsCanvas" aria-hidden="true"></canvas>
       </div>`, ' vr-col-single');
    wireRegionsEditing();
  }
  applyLayout();
}

// Sizes every image and overlay canvas explicitly from one scale factor
// (display px per image px) so the baseline, current and diff line up pixel
// for pixel, and the ignore/changed-region overlays land where they belong.
function applyLayout() {
  const stage = $('vrImages');
  const wraps = [...stage.querySelectorAll('.vr-img-wrap')];
  if (!wraps.length) { updateZoomUi(); return; }
  const cw = Number(wraps[0].dataset.cw) || 1;
  const ch = Number(wraps[0].dataset.ch) || 1;
  const cols = stage.querySelector('.vr-cols') ? 2 : 1;
  const style = getComputedStyle(stage);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const boxW = (stage.clientWidth - padX - (cols - 1) * 12) / cols - 2;
  const extra = stage.querySelector('.vr-overlay-slider') ? 30 : 0;
  const boxH = stage.clientHeight - padY - 22 - extra;
  // A hidden panel (another console tab active) measures as 0×0 — keep the
  // last good scale instead of collapsing the images.
  if (stage.clientWidth > 0) lastScale = scaleForZoom(zoom, cw, ch, boxW, boxH);
  const scale = lastScale;

  for (const wrap of wraps) {
    wrap.style.width = `${Math.max(1, Math.round(cw * scale))}px`;
    wrap.style.height = `${Math.max(1, Math.round(ch * scale))}px`;
    for (const img of wrap.querySelectorAll('img.vr-img')) {
      img.style.width = `${Math.max(1, Math.round(Number(img.dataset.w) * scale))}px`;
      img.style.height = `${Math.max(1, Math.round(Number(img.dataset.h) * scale))}px`;
    }
    const canvas = wrap.querySelector('canvas.vr-ov');
    if (canvas) {
      canvas.width = Math.max(1, Math.round(cw * scale));
      canvas.height = Math.max(1, Math.round(ch * scale));
    }
  }
  updateOverlayClip();
  updateZoomUi();
  drawOverlays();
}

function updateZoomUi() {
  const sel = $('vrZoom');
  if (!sel) return;
  sel.value = String(zoom);
  $('vrZoomNow').textContent = typeof zoom === 'number' ? '' : formatZoom(lastScale);
  $('vrZoomIn').disabled = lastScale >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 1e-9;
  $('vrZoomOut').disabled = lastScale <= ZOOM_STEPS[0] + 1e-9;
}

function overlayColors() {
  const cs = getComputedStyle(document.body);
  return { accent: cs.getPropertyValue('--accent').trim() || '#4fc3f7' };
}

// Draws, on every overlay canvas in the viewer: ignore regions (grey,
// dashed, numbered to match the chip list), every changed region (thin
// orange box) and the currently selected changed region (thick yellow on
// black, visible on any page colour).
function drawOverlays(preview = null) {
  const d = activeData();
  const view = currentView();
  const scale = lastScale;
  const { accent } = overlayColors();
  for (const canvas of $('vrImages').querySelectorAll('canvas.vr-ov')) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '600 11px sans-serif';
    ctx.textBaseline = 'top';

    d.ignoreRegions.forEach((r, i) => {
      const x = r.x * scale; const y = r.y * scale; const w = r.w * scale; const h = r.h * scale;
      const hi = i === highlightedIgnoreIdx;
      if (view !== 'diff') {
        ctx.fillStyle = hi ? 'rgba(79,195,247,0.35)' : 'rgba(128,128,128,0.45)';
        ctx.fillRect(x, y, w, h);
      }
      ctx.setLineDash([5, 3]);
      ctx.lineWidth = hi ? 3 : 1.5;
      ctx.strokeStyle = hi ? accent : 'rgba(255,255,255,0.95)';
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.setLineDash([]);
      const label = String(i + 1);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(x, y, ctx.measureText(label).width + 8, 15);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x + 4, y + 2);
    });

    const r = d.result;
    if (r && view !== 'baseline') {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,152,0,0.9)';
      r.changedRegions.forEach((cr, i) => {
        if (i === d.activeRegion) return;
        ctx.strokeRect(cr.x * scale - 1.5, cr.y * scale - 1.5, cr.w * scale + 3, cr.h * scale + 3);
      });
      const act = r.changedRegions[d.activeRegion];
      if (act) {
        const x = act.x * scale - 4; const y = act.y * scale - 4;
        const w = act.w * scale + 8; const h = act.h * scale + 8;
        ctx.lineWidth = 5;
        ctx.strokeStyle = '#000000';
        ctx.strokeRect(x, y, w, h);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#ffd400';
        ctx.strokeRect(x, y, w, h);
      }
    }

    if (preview && canvas.id === 'vrRegionsCanvas') {
      ctx.fillStyle = 'rgba(79,195,247,0.3)';
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.fillRect(preview.x * scale, preview.y * scale, preview.w * scale, preview.h * scale);
      ctx.strokeRect(preview.x * scale, preview.y * scale, preview.w * scale, preview.h * scale);
    }
  }
}

// ─── Overlay (slider) view ──────────────────────────────────────────────────

function updateOverlayClip() {
  const top = $('vrOverlayTop');
  const line = $('vrOverlayLine');
  if (!top || !line) return;
  top.style.clipPath = `inset(0 0 0 ${overlayPos}%)`;
  line.style.left = `${overlayPos}%`;
  const slider = $('vrOverlaySlider');
  if (slider) {
    slider.value = String(overlayPos);
    slider.setAttribute('aria-valuetext', `${overlayPos}% baseline, ${100 - overlayPos}% current`);
  }
}

function wireOverlay() {
  const wrap = $('vrOverlayWrap');
  const slider = $('vrOverlaySlider');
  slider.addEventListener('input', () => {
    overlayPos = Number(slider.value);
    updateOverlayClip();
  });
  // Dragging anywhere on the image moves the divider too.
  let dragging = false;
  const fromEvent = (e) => {
    const rect = wrap.getBoundingClientRect();
    overlayPos = Math.round(Math.min(100, Math.max(0, ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100)));
    updateOverlayClip();
  };
  wrap.addEventListener('pointerdown', (e) => {
    dragging = true;
    wrap.setPointerCapture?.(e.pointerId);
    fromEvent(e);
  });
  wrap.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
  const stop = () => { dragging = false; };
  wrap.addEventListener('pointerup', stop);
  wrap.addEventListener('pointercancel', stop);
}

// ─── Changed-region navigation ──────────────────────────────────────────────

function renderRegionNav() {
  const d = activeData();
  const r = d.result;
  const count = r ? r.changedRegions.length : 0;
  $('vrNav').hidden = !r;
  $('vrPrevRegion').disabled = count === 0;
  $('vrNextRegion').disabled = count === 0;
  const pos = $('vrRegionPos');
  if (!r) { pos.textContent = ''; return; }
  if (count === 0) { pos.textContent = 'No changed regions'; return; }
  const act = r.changedRegions[d.activeRegion];
  pos.textContent = act
    ? `Change ${d.activeRegion + 1} of ${count}${r.truncated ? '+' : ''} · ${act.pixels.toLocaleString()} px`
    : `${count}${r.truncated ? '+' : ''} changed region${count === 1 ? '' : 's'}`;
}

function goToRegion(dir) {
  const d = activeData();
  const r = d.result;
  if (!r || !r.changedRegions.length) return;
  d.activeRegion = nextIndex(d.activeRegion, r.changedRegions.length, dir);
  if (currentView() === 'baseline') {
    setRegionsEditMode(false);
    d.viewMode = preferredView;
    renderImages();
  }
  const region = r.changedRegions[d.activeRegion];
  const stage = $('vrImages');
  const zoomed = zoomToShowRegion(region, lastScale, stage.clientWidth, stage.clientHeight);
  if (zoomed > lastScale + 1e-9) {
    zoom = zoomed;
    lsSet(LS_ZOOM, String(zoom));
  }
  applyLayout();
  renderRegionNav();
  const wrap = stage.querySelector('.vr-img-wrap');
  if (wrap) {
    const sRect = stage.getBoundingClientRect();
    const wRect = wrap.getBoundingClientRect();
    const offX = wRect.left - sRect.left + stage.scrollLeft;
    const offY = wRect.top - sRect.top + stage.scrollTop;
    const { left, top } = scrollToCenter(region, lastScale, stage.clientWidth, stage.clientHeight, offX, offY);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    stage.scrollTo({ left, top, behavior: reduce ? 'auto' : 'smooth' });
  }
}

// N / P step through changed regions, + / − / 0 zoom — only when focus
// isn't in a text field, and never with a modifier (those belong to the
// app-wide shortcuts in shortcuts.js).
function onPanelKeydown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!activeData().baselineB64) return;
  const actions = {
    n: () => goToRegion(1),
    p: () => goToRegion(-1),
    '+': () => setZoom(stepZoom(lastScale, 1)),
    '=': () => setZoom(stepZoom(lastScale, 1)),
    '-': () => setZoom(stepZoom(lastScale, -1)),
    0: () => setZoom('fit'),
  };
  const action = actions[e.key.length === 1 ? e.key.toLowerCase() : ''];
  if (!action) return;
  e.preventDefault();
  action();
}

// ─── Ignore regions (#277) ──────────────────────────────────────────────────
// Drawn directly on the baseline image, tracked in image-pixel coordinates
// (not display coordinates) so a region stays correctly placed regardless of
// how the panel currently scales the image. Editing is gated behind an
// explicit "Edit ignore regions" toggle so a normal click on the baseline
// image (e.g. to focus the panel) never accidentally draws a region.

function setRegionsEditMode(on) {
  regionsEditMode = on;
  const btn = $('vrEditRegionsBtn');
  if (!btn) return;
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', String(on));
  $('vrRegionsHint').hidden = !on;
  renderIgnoreBar();
}

function toggleRegionsEditMode() {
  setRegionsEditMode(!regionsEditMode);
  renderImages();
  // In a short console panel the viewer can sit below the fold — bring the
  // baseline into view so the drag target is actually on screen.
  if (regionsEditMode) $('vrImages').scrollIntoView({ block: 'nearest' });
}

function persistIgnoreRegionsIfSaved() {
  const d = activeData();
  // Only a *saved* baseline has anywhere to persist regions to — an
  // in-memory-only capture just keeps them in sessionData until Save as…
  // is used, at which point saveActiveBaseline() sends the whole set.
  if (d.baselineId) testerBrowser.visualRegression.setIgnoreRegions(d.baselineId, d.ignoreRegions);
}

function removeIgnoreRegion(idx) {
  const d = activeData();
  if (idx < 0 || idx >= d.ignoreRegions.length) return;
  d.ignoreRegions.splice(idx, 1);
  highlightedIgnoreIdx = -1;
  persistIgnoreRegionsIfSaved();
  markStale();
  renderIgnoreBar();
  drawOverlays();
  // Keep keyboard focus in the list (or on the edit button once it's empty).
  const next = $('vrIgnoreList').querySelector(`[data-remove-region="${Math.min(idx, d.ignoreRegions.length - 1)}"]`);
  (next || $('vrEditRegionsBtn')).focus();
}

function renderIgnoreBar() {
  const d = activeData();
  const bar = $('vrIgnoreBar');
  const regions = d.ignoreRegions;
  bar.hidden = !d.baselineB64 || (!regions.length && !regionsEditMode);
  $('vrEditRegionsBtn').textContent = regionsEditMode
    ? 'Done editing regions'
    : `Edit ignore regions${regions.length ? ` (${regions.length})` : ''}`;
  $('vrIgnoreClearBtn').hidden = regions.length < 2;
  $('vrIgnoreList').innerHTML = regions.length
    ? regions.map((r, i) => `<li class="panel-chip diff-ignore-chip vr-ign-chip" data-region-idx="${i}">
        <span><b>${i + 1}</b> ${escHtml(describeRegion(r))}</span>
        <button type="button" class="diff-chip-x" data-remove-region="${i}" aria-label="Remove ignore region ${i + 1} (${escHtml(describeRegion(r))})" title="Remove">×</button>
      </li>`).join('')
    : '<li class="diff-ignore-none">None — drag on the baseline to add one.</li>';
  const info = d.baselineInfo;
  if (regions.length && info) {
    const covered = regionsCoverage(regions, info.w, info.h);
    const pct = formatPct(covered, info.w * info.h);
    $('vrIgnoreNote').textContent = `${pct}% of the baseline is excluded from the changed-pixel % (neither counted as changed nor in the total).`;
  } else {
    $('vrIgnoreNote').textContent = '';
  }
}

function wireRegionsEditing() {
  const canvas = $('vrRegionsCanvas');
  if (!canvas) return;
  canvas.classList.toggle('vr-regions-editable', regionsEditMode);
  if (!regionsEditMode) return;
  const info = activeData().baselineInfo;

  let dragStart = null;
  const toImageCoords = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.round((e.clientX - rect.left) / lastScale), y: Math.round((e.clientY - rect.top) / lastScale) };
  };

  canvas.onmousedown = (e) => { dragStart = toImageCoords(e); };
  canvas.onmousemove = (e) => {
    if (!dragStart) return;
    drawOverlays(rectFromPoints(dragStart, toImageCoords(e)));
  };
  canvas.onmouseup = (e) => {
    if (!dragStart) return;
    const end = toImageCoords(e);
    const start = dragStart;
    dragStart = null;
    const d = activeData();

    // A near-zero drag reads as a click on an existing region instead of
    // an attempt to draw a new (degenerate) one.
    if (Math.hypot(end.x - start.x, end.y - start.y) < 4) {
      const idx = regionIndexAt(end, d.ignoreRegions);
      if (idx >= 0) {
        d.ignoreRegions.splice(idx, 1);
        persistIgnoreRegionsIfSaved();
        markStale();
        renderIgnoreBar();
      }
      drawOverlays();
      return;
    }

    const rect = clampRegion(rectFromPoints(start, end), info.w, info.h);
    if (rect) {
      d.ignoreRegions.push(rect);
      persistIgnoreRegionsIfSaved();
      markStale();
      renderIgnoreBar();
    }
    drawOverlays();
  };
  canvas.onmouseleave = () => { dragStart = null; drawOverlays(); };
}

// ─── Capture + compare ──────────────────────────────────────────────────────

async function captureBaseline() {
  if (!getActiveId()) return;
  const sessionId  = getActiveId();
  const captureBtn = $('vrCaptureBtn');

  captureBtn.disabled = true;
  captureBtn.textContent = 'Capturing…';
  const progress = 'Capturing the baseline…';
  setMessage(progress);

  const b64 = await testerBrowser.visualRegression.captureScreenshot(sessionId, { fullPage: isFullPage() });
  let dims = null;
  if (b64) dims = await loadImage(b64).then((img) => ({ w: img.width, h: img.height })).catch(() => null);
  captureBtn.disabled = false;
  captureBtn.textContent = 'Capture baseline';
  clearProgress(sessionId, progress);

  // The user may have switched sessions while the screenshot was in flight.
  if (sessionId !== getActiveId()) return;
  if (!b64 || !dims) { setMessage('Screenshot failed.', true); return; }

  const sessions = await testerBrowser.sessions.list().catch(() => []);
  const url = sessions.find((s) => s.id === sessionId)?.url || '';

  // A fresh baseline invalidates any previous comparison for this session,
  // and — since it's pixel-different from whatever saved baseline (if any)
  // was previously loaded — its own saved identity and ignore regions too;
  // it's no longer backed by that file until explicitly saved again.
  const d = activeData();
  d.baselineB64 = b64;
  d.baselineId  = null;
  d.baselineInfo = { name: null, url, capturedAt: Date.now(), w: dims.w, h: dims.h, source: 'capture' };
  resetComparison(d);
  d.ignoreRegions = [];
  setRegionsEditMode(false);
  renderAll();
}

function resetComparison(d) {
  d.currentB64  = null;
  d.diffDataUrl = null;
  d.result      = null;
  d.stale       = false;
  d.activeRegion = -1;
  d.viewMode    = 'baseline';
  d.message     = '';
}

async function runCompare() {
  const sessionId = getActiveId();
  const d0 = activeData();
  if (!sessionId || !d0.baselineB64) return;
  // Defaults to the baseline's own session (this feature's original,
  // single-session behavior) unless the user picked a different one to
  // capture the "current" screenshot from — see #127.
  const targetId = d0.compareSessionId || sessionId;
  const pick = $('vrComparePick');
  const compareLabel = d0.compareSessionId ? (pick.selectedOptions[0]?.textContent || 'another tab') : 'this tab';
  const compareBtn = $('vrCompareBtn');

  compareBtn.disabled = true;
  compareBtn.textContent = 'Comparing…';
  const progress = 'Capturing the current page and comparing…';
  setMessage(progress);

  try {
    const captured = await testerBrowser.visualRegression.captureScreenshot(targetId, { fullPage: isFullPage() });
    if (sessionId !== getActiveId()) return;
    if (!captured) { setMessage('Screenshot failed — the selected tab may have been closed.', true); return; }
    await computeAndShow(sessionId, captured, compareLabel);
  } catch (err) {
    if (sessionId === getActiveId()) setMessage(`Compare failed: ${err.message}`, true);
  } finally {
    compareBtn.disabled = !activeData().baselineB64;
    compareBtn.textContent = 'Compare';
    clearProgress(sessionId, progress);
  }
}

// "Update result": re-run the pixel diff on the two screenshots already in
// hand, with the current tolerance and ignore regions — no re-capture.
async function recomputeFromStored() {
  const sessionId = getActiveId();
  const d = activeData();
  if (!d.baselineB64 || !d.currentB64 || !d.result) return;
  const progress = 'Comparing again with the new settings…';
  setMessage(progress);
  try {
    await computeAndShow(sessionId, d.currentB64, d.result.compareLabel);
  } catch (err) {
    if (sessionId === getActiveId()) setMessage(`Compare failed: ${err.message}`, true);
  } finally {
    clearProgress(sessionId, progress);
  }
}

async function computeAndShow(sessionId, currentB64, compareLabel) {
  const { baselineB64, threshold, ignoreRegions } = activeData();
  const regions = ignoreRegions.map((r) => ({ ...r }));
  const [baseImg, curImg] = await Promise.all([
    loadImage(baselineB64).catch(() => { throw new Error('could not decode baseline screenshot'); }),
    loadImage(currentB64).catch(() => { throw new Error('could not decode current screenshot'); }),
  ]);

  const w = Math.max(baseImg.width,  curImg.width);
  const h = Math.max(baseImg.height, curImg.height);
  const sizeMismatch = baseImg.width !== curImg.width || baseImg.height !== curImg.height;

  const out = await computeDiffInWorker(baseImg, curImg, w, h, threshold, regions);
  if (sessionId !== getActiveId()) return;

  const d = activeData();
  d.currentB64  = currentB64;
  d.diffDataUrl = out.diffDataUrl;
  d.result = {
    diffCount: out.diffCount, total: out.total, w, h,
    baseW: baseImg.width, baseH: baseImg.height, curW: curImg.width, curH: curImg.height, sizeMismatch,
    changedRegions: out.changedRegions || [], truncated: !!out.changedRegionsTruncated,
    ignoredPx: w * h - out.total, ignoredCount: regions.length,
    threshold, comparedAt: Date.now(), compareLabel,
  };
  // Settings edited while this compare was running aren't reflected in it.
  d.stale = d.threshold !== threshold || JSON.stringify(d.ignoreRegions) !== JSON.stringify(regions);
  d.activeRegion = -1;
  d.message = '';
  if (d.viewMode === 'baseline' || regionsEditMode) d.viewMode = preferredView;
  setRegionsEditMode(false);
  renderAll();
}

function isFullPage() {
  return $('vrFullPage').checked;
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
    img.src = png(b64);
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
      const { diffData, diffCount, total, changedRegions, changedRegionsTruncated } = e.data;
      const cd = document.createElement('canvas');
      cd.width = w;
      cd.height = h;
      cd.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(diffData), w, h), 0, 0);
      resolve({ diffDataUrl: cd.toDataURL('image/png'), diffCount, total, changedRegions, changedRegionsTruncated });
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

function setBaselinesOpen(open) {
  baselinesOpen = open;
  $('vrBaselines').hidden = !open;
  $('vrBaselinesToggle').setAttribute('aria-expanded', String(open));
  $('vrBaselinesToggle').classList.toggle('active', open);
  if (open) {
    pendingDeleteId = null;
    renderBaselineList();
    refreshBaselinesList();
    $('vrBaselineSearch').focus();
  }
}

async function refreshBaselinesList() {
  if (!$('vrBaselineList')) return;
  savedBaselines = await testerBrowser.visualRegression.listBaselines();
  $('vrBaselineCount').textContent = savedBaselines.length ? ` (${savedBaselines.length})` : '';
  if (baselinesOpen) renderBaselineList();
}

function renderBaselineList() {
  const list = $('vrBaselineList');
  const query = $('vrBaselineSearch').value;
  const shown = filterBaselines(savedBaselines, query);
  const note = $('vrBaselineFilterNote');
  note.textContent = query.trim() && savedBaselines.length ? `Showing ${shown.length} of ${savedBaselines.length}` : '';

  if (!savedBaselines.length) {
    list.innerHTML = '<li class="vr-bl-empty">No saved baselines yet. Capture one and use <b>Save as…</b>, or <b>Import…</b> one exported elsewhere.</li>';
    return;
  }
  if (!shown.length) {
    list.innerHTML = `<li class="vr-bl-empty">No saved baselines match “${escHtml(query.trim())}”.</li>`;
    return;
  }
  const activeId = activeData().baselineId;
  list.innerHTML = shown.map((b) => {
    const id = escHtml(b.id);
    const name = escHtml(b.name);
    const thumb = thumbCache.get(b.id);
    const inUse = b.id === activeId;
    const regions = (b.ignoreRegions || []).length;
    const confirming = pendingDeleteId === b.id;
    return `<li class="vr-bl-item${inUse ? ' in-use' : ''}" data-id="${id}"${inUse ? ' aria-current="true"' : ''}>
      <div class="vr-bl-thumb">${thumb ? `<img src="${thumb}" alt="" />` : '<span class="vr-bl-thumb-ph" aria-hidden="true">…</span>'}</div>
      <div class="vr-bl-info">
        <div class="vr-bl-name">${name}${inUse ? ' <span class="panel-chip vr-inuse">In use</span>' : ''}</div>
        <div class="vr-bl-sub">${escHtml(new Date(b.capturedAt).toLocaleString())} · ${b.width}×${b.height}${regions ? ` · ${regions} ignore region${regions === 1 ? '' : 's'}` : ''}</div>
        ${b.url ? `<div class="vr-bl-url" title="${escHtml(b.url)}">${escHtml(b.url)}</div>` : ''}
      </div>
      <div class="vr-bl-actions">
        ${confirming
          ? `<span class="vr-bl-confirm" role="alert">Delete “${name}” permanently?</span>
             <button type="button" class="diff-small-btn vr-danger" data-act="confirm-delete" aria-label="Yes, delete baseline ${name}">Delete</button>
             <button type="button" class="diff-small-btn" data-act="cancel-delete">Cancel</button>`
          : `<button type="button" class="diff-small-btn vr-bl-use" data-act="use" aria-label="Use baseline ${name}">${inUse ? 'Reload' : 'Use'}</button>
             <button type="button" class="diff-small-btn vr-bl-rename" data-act="rename" aria-label="Rename baseline ${name}">Rename…</button>
             <button type="button" class="diff-small-btn vr-bl-export" data-act="export" aria-label="Export baseline ${name}">Export…</button>
             <button type="button" class="diff-small-btn vr-bl-delete" data-act="delete" aria-label="Delete baseline ${name}">Delete</button>`}
      </div>
    </li>`;
  }).join('');
  loadThumbnails(shown.map((b) => b.id));
}

// Thumbnails come from the full baseline PNG (the only IPC there is),
// scaled down once on a canvas and cached — one at a time, so opening the
// list with many large full-page baselines doesn't decode them all at once.
async function loadThumbnails(ids) {
  if (thumbQueueRunning) return;
  thumbQueueRunning = true;
  try {
    for (const id of ids) {
      if (thumbCache.has(id) || !baselinesOpen) continue;
      let thumb = '';
      try {
        const entry = await testerBrowser.visualRegression.getBaseline(id);
        if (entry) {
          const img = await loadImage(entry.b64);
          const tw = 96;
          const th = 60;
          const scale = tw / img.width;
          const c = document.createElement('canvas');
          c.width = tw;
          c.height = Math.min(th, Math.max(1, Math.round(img.height * scale)));
          c.getContext('2d').drawImage(img, 0, 0, img.width, c.height / scale, 0, 0, tw, c.height);
          thumb = c.toDataURL('image/png');
        }
      } catch { /* leave the placeholder */ }
      thumbCache.set(id, thumb);
      const holder = $('vrBaselineList')?.querySelector(`.vr-bl-item[data-id="${CSS.escape(id)}"] .vr-bl-thumb`);
      if (holder && thumb) holder.innerHTML = `<img src="${thumb}" alt="" />`;
    }
  } finally {
    thumbQueueRunning = false;
  }
  // Items added (or filtered into view) while the queue was busy.
  const missing = [...($('vrBaselineList')?.querySelectorAll('.vr-bl-item') || [])]
    .map((li) => li.dataset.id).filter((id) => !thumbCache.has(id));
  if (missing.length && baselinesOpen) loadThumbnails(missing);
}

async function onBaselineListClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.vr-bl-item')?.dataset.id;
  if (!id) return;
  const act = btn.dataset.act;
  if (act === 'use') await loadBaseline(id);
  else if (act === 'rename') await renameBaseline(id);
  else if (act === 'export') await exportBaseline(id);
  else if (act === 'delete') {
    pendingDeleteId = id;
    renderBaselineList();
    focusInItem(id, '[data-act="cancel-delete"]');
  } else if (act === 'cancel-delete') {
    pendingDeleteId = null;
    renderBaselineList();
    focusInItem(id, '[data-act="delete"]');
  } else if (act === 'confirm-delete') {
    await deleteBaseline(id);
  }
}

function focusInItem(id, selector) {
  $('vrBaselineList').querySelector(`.vr-bl-item[data-id="${CSS.escape(id)}"] ${selector}`)?.focus();
}

async function loadBaseline(id) {
  const statusEl = $('vrBaselineStatus');
  const entry = await testerBrowser.visualRegression.getBaseline(id);
  if (!entry) { statusEl.textContent = 'Could not load that baseline.'; return; }

  const d = activeData();
  d.baselineB64   = entry.b64;
  d.baselineId    = id;
  d.baselineInfo  = {
    name: entry.meta.name, url: entry.meta.url, capturedAt: entry.meta.capturedAt,
    w: entry.meta.width, h: entry.meta.height, source: 'saved',
  };
  resetComparison(d);
  d.ignoreRegions = (entry.meta.ignoreRegions || []).map((r) => ({ ...r }));
  statusEl.textContent = `Loaded "${entry.meta.name}".`;
  setBaselinesOpen(false);
  refreshVR();
  $('vrCompareBtn').focus();
}

// prompt()/confirm() with a real return value would be simplest here, but
// prompt() is blocked outright in this app's renderer (contextIsolation) —
// silently returns null. An inline modal (same shell as record-playback.js's
// assertion dialog) is the established substitute. The page's native view
// is hidden while it's open so it isn't painted over the dialog.
async function promptBaselineName(defaultValue, { title = 'Save baseline as…', okLabel = 'Save', note = '' } = {}) {
  document.getElementById('vrSaveDlg')?.remove();
  const returnFocus = document.activeElement;
  await testerBrowser.layout.setViewerVisible(false);
  return new Promise((resolve) => {
    const dlg = document.createElement('div');
    dlg.id = 'vrSaveDlg';
    dlg.className = 'rp-assert-dlg';
    dlg.innerHTML = `
      <div class="rp-assert-dlg-inner" role="dialog" aria-modal="true" aria-labelledby="vrSaveDlgTitle">
        <div class="rp-assert-dlg-title" id="vrSaveDlgTitle">${escHtml(title)}</div>
        <label class="diff-label" for="vrSaveNameInput">Name</label>
        <input class="rp-input" id="vrSaveNameInput" value="${escHtml(defaultValue)}" />
        ${note ? `<div class="vr-hint-inline">${escHtml(note)}</div>` : ''}
        <div class="rp-assert-dlg-btns">
          <button type="button" class="rp-btn" id="vrSaveDlgOk">${escHtml(okLabel)}</button>
          <button type="button" class="rp-btn" id="vrSaveDlgCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    const input = $('vrSaveNameInput');
    input.focus();
    input.select();
    const finish = (value) => {
      dlg.remove();
      testerBrowser.layout.setViewerVisible(true);
      if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
      resolve(value);
    };
    const ok = () => { const v = input.value.trim(); finish(v || null); };
    $('vrSaveDlgOk').addEventListener('click', ok);
    $('vrSaveDlgCancel').addEventListener('click', () => finish(null));
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === input) { e.preventDefault(); ok(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    });
  });
}

async function saveActiveBaseline() {
  const d = activeData();
  if (!d.baselineB64) return;
  const statusEl = $('vrBaselineStatus');

  const sessions = await testerBrowser.sessions.list();
  const url = d.baselineInfo?.url || sessions.find((s) => s.id === getActiveId())?.url || '';
  const defaultName = url ? `${url} — ${new Date().toLocaleString()}` : `Baseline — ${new Date().toLocaleString()}`;
  const name = await promptBaselineName(defaultName);
  if (!name) return;

  const meta = await testerBrowser.visualRegression.saveBaseline(name, url, d.baselineB64);
  if (!meta) { statusEl.textContent = 'Failed to save baseline.'; return; }
  d.baselineId = meta.id;
  d.baselineInfo = { ...d.baselineInfo, name, url, source: 'saved' };
  if (d.ignoreRegions.length) {
    await testerBrowser.visualRegression.setIgnoreRegions(meta.id, d.ignoreRegions);
  }
  statusEl.textContent = `Saved as "${name}".`;
  await refreshBaselinesList();
  renderAll();
}

// There's no rename IPC: a rename saves the same PNG under the new name,
// carries the ignore regions over, and only then deletes the old entry —
// so a failure part-way never loses the original. The saved date becomes
// today (the store stamps it at save time); the dialog says so.
async function renameBaseline(id) {
  const statusEl = $('vrBaselineStatus');
  const old = savedBaselines.find((b) => b.id === id);
  if (!old) return;
  const name = await promptBaselineName(old.name, {
    title: 'Rename baseline', okLabel: 'Rename',
    note: 'Renaming re-saves the baseline, so its saved date becomes today.',
  });
  if (!name || name === old.name) return;
  const entry = await testerBrowser.visualRegression.getBaseline(id);
  if (!entry) { statusEl.textContent = 'Could not read that baseline.'; return; }
  const meta = await testerBrowser.visualRegression.saveBaseline(name, entry.meta.url, entry.b64);
  if (!meta) { statusEl.textContent = 'Rename failed.'; return; }
  if (entry.meta.ignoreRegions?.length) {
    await testerBrowser.visualRegression.setIgnoreRegions(meta.id, entry.meta.ignoreRegions);
  }
  await testerBrowser.visualRegression.deleteBaseline(id);
  for (const d of sessionData.values()) {
    if (d.baselineId === id) {
      d.baselineId = meta.id;
      d.baselineInfo = { ...d.baselineInfo, name };
    }
  }
  if (thumbCache.has(id)) { thumbCache.set(meta.id, thumbCache.get(id)); thumbCache.delete(id); }
  statusEl.textContent = `Renamed to "${name}".`;
  await refreshBaselinesList();
  renderAll();
  focusInItem(meta.id, '[data-act="rename"]');
}

async function exportBaseline(id) {
  const statusEl = $('vrBaselineStatus');
  const result = await testerBrowser.visualRegression.exportBaseline(id);
  if (result.canceled) { statusEl.textContent = ''; return; }
  statusEl.textContent = result.ok
    ? `Exported to ${result.path.split(/[\\/]/).pop()}`
    : (result.error || 'Export failed');
}

async function importBaseline() {
  const statusEl = $('vrBaselineStatus');
  const result = await testerBrowser.visualRegression.importBaseline();
  if (result.canceled) { statusEl.textContent = ''; return; }
  if (!result.ok) { statusEl.textContent = result.error || 'Import failed'; return; }
  statusEl.textContent = `Imported "${result.imported.name}".`;
  await refreshBaselinesList();
  if (!baselinesOpen) setBaselinesOpen(true);
}

async function deleteBaseline(id) {
  await testerBrowser.visualRegression.deleteBaseline(id);
  pendingDeleteId = null;
  thumbCache.delete(id);
  // Stays loaded in any tab using it — just no longer backed by a saved
  // file (same as a freshly captured one).
  for (const d of sessionData.values()) {
    if (d.baselineId === id) d.baselineId = null;
  }
  $('vrBaselineStatus').textContent = 'Baseline deleted.';
  await refreshBaselinesList();
  renderAll();
  $('vrBaselineSearch').focus();
}
