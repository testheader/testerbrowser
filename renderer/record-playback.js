/* global testerBrowser */
import { getActiveId } from './tabs.js';
import { escHtml } from './utils.js';

let initialized = false;
let isRecording = false;
let pollInterval = null;
let currentSteps = [];
let savedTests = [];

// Step-by-step playback: when a run is paused after a step, stepAdvance
// resolves to 'next' or 'stop' via the Next/Stop buttons below.
let stepAdvance = null;
let stepStopped = false;

export function initRecordPlayback() {
  const panel = document.getElementById('testsPanel');
  if (initialized) { refreshTestList(); return; }
  initialized = true;

  panel.innerHTML = `
    <div class="rp-wrap">
      <div class="rp-col rp-record-col" id="rpRecordCol">
        <div class="rp-section-title">Record New Test</div>
        <div class="rp-record-form">
          <input class="rp-input" id="rpTestName" type="text" placeholder="Test name…" />
          <div class="rp-record-btns">
            <button class="rp-btn rp-btn-record" id="rpStartBtn">&#9679; Start</button>
            <button class="rp-btn rp-btn-stop" id="rpStopBtn" disabled>&#9632; Stop</button>
            <button class="rp-btn" id="rpSaveBtn" disabled>Save</button>
            <button class="rp-btn" id="rpDiscardBtn" disabled>Discard</button>
          </div>
          <span class="rp-form-status" id="rpFormStatus"></span>
        </div>
        <div id="rpLiveSteps" class="rp-live-steps"></div>
      </div>

      <div class="rp-splitter" id="rpSplitter1" title="Drag to resize"></div>

      <div class="rp-col rp-saved-col" id="rpSavedCol">
        <div class="rp-section-title">Replay Tests</div>
        <label class="rp-step-mode-toggle" title="Pause after each step instead of running the test straight through — useful for debugging where a script fails. Applies to the single Run button only, not Run N×.">
          <input type="checkbox" id="rpStepModeToggle" /> Step-by-step playback
        </label>
        <div id="rpTestList" class="rp-test-list"></div>
      </div>

      <div class="rp-splitter" id="rpSplitter2" title="Drag to resize"></div>

      <div class="rp-main">
        <div id="rpRunView" class="rp-run-view" hidden>
          <div class="rp-run-header">
            <span id="rpRunTitle" class="rp-run-title"></span>
            <div id="rpStepControls" class="rp-step-controls" hidden>
              <button class="rp-btn rp-btn-sm" id="rpNextStepBtn">Next</button>
              <button class="rp-btn rp-btn-sm rp-btn-stop" id="rpStopStepBtn">Stop</button>
            </div>
            <button class="rp-btn rp-btn-sm" id="rpRunClose">&#10005;</button>
          </div>
          <div class="rp-progress-bar"><div class="rp-progress-fill" id="rpProgressFill"></div></div>
          <div id="rpRunStatus" class="rp-run-status"></div>
          <div id="rpStepsList" class="rp-steps-list"></div>
          <div id="rpRepeatResults" class="rp-repeat-results" hidden></div>
        </div>
        <div id="rpRunPlaceholder" class="rp-placeholder">Select a test and click Run to start</div>
      </div>
    </div>
  `;

  initColumnResize();

  document.getElementById('rpStartBtn').addEventListener('click', startRecording);
  document.getElementById('rpStopBtn').addEventListener('click', stopRecording);
  document.getElementById('rpSaveBtn').addEventListener('click', saveRecordedTest);
  document.getElementById('rpDiscardBtn').addEventListener('click', discardRecording);
  document.getElementById('rpRunClose').addEventListener('click', () => {
    document.getElementById('rpRunView').hidden = true;
    document.getElementById('rpRunPlaceholder').hidden = false;
  });
  document.getElementById('rpNextStepBtn').addEventListener('click', () => resolveStepAdvance('next'));
  document.getElementById('rpStopStepBtn').addEventListener('click', () => resolveStepAdvance('stop'));

  refreshTestList();
}

// Minimums keep every column usable and stop a splitter from being dragged
// to (or past) zero. RP_MIN_SAVED in particular is wide enough that a step's
// type/selector/value fields (renderSavedStepsHtml) sit side by side without
// truncating at the default window size — the whole point of this ticket.
const RP_MIN_RECORD = 180;
const RP_MIN_SAVED  = 280;
const RP_MIN_MAIN   = 200;
const RP_SPLITTER_W = 6; // matches .rp-splitter's width in style.css

// Mirrors the drag-resize pattern already used for the console panel
// (layout.js initLayout) and the detail panel (detail-panel.js
// initDetailPanel), just on the X axis and with two splitters instead of
// one. Widths are restored from and saved back to testerBrowser.settings
// (settings.json) rather than localStorage, per this ticket — the same
// store security.js's rule overrides already use.
function initColumnResize() {
  const wrap      = document.querySelector('#testsPanel .rp-wrap');
  const recordCol = document.getElementById('rpRecordCol');
  const savedCol  = document.getElementById('rpSavedCol');
  const splitter1 = document.getElementById('rpSplitter1');
  const splitter2 = document.getElementById('rpSplitter2');

  let widths = { record: RP_MIN_RECORD, saved: RP_MIN_SAVED + 140 };

  function applyWidths() {
    recordCol.style.width = widths.record + 'px';
    savedCol.style.width  = widths.saved + 'px';
  }

  async function persistWidths() {
    try { await testerBrowser.settings.set({ recordPlaybackColumnWidths: widths }); } catch {}
  }

  testerBrowser.settings.get().then((settings) => {
    const saved = settings?.recordPlaybackColumnWidths;
    if (saved && typeof saved.record === 'number' && typeof saved.saved === 'number') {
      widths = { record: saved.record, saved: saved.saved };
    }
    applyWidths();
  }).catch(() => applyWidths());

  function dragSplitter(handle, { getStartWidth, getMax, setWidth }) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = getStartWidth();
      handle.classList.add('dragging');
      const onMove = (ev) => {
        const max = getMax();
        const newW = Math.max(0, Math.min(startW + (ev.clientX - startX), max));
        setWidth(newW);
        applyWidths();
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        persistWidths();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Splitter 1 (between Record and Replay tests) resizes the record column;
  // its ceiling leaves the saved column and the run view at their own
  // minimums plus room for both splitters.
  dragSplitter(splitter1, {
    getStartWidth: () => widths.record,
    getMax: () => Math.max(RP_MIN_RECORD, wrap.offsetWidth - widths.saved - RP_MIN_MAIN - RP_SPLITTER_W * 2),
    setWidth: (w) => { widths.record = Math.max(RP_MIN_RECORD, w); },
  });

  // Splitter 2 (between Replay tests and the run view) resizes the saved
  // column; its ceiling leaves the run view at its own minimum.
  dragSplitter(splitter2, {
    getStartWidth: () => widths.saved,
    getMax: () => Math.max(RP_MIN_SAVED, wrap.offsetWidth - widths.record - RP_MIN_MAIN - RP_SPLITTER_W * 2),
    setWidth: (w) => { widths.saved = Math.max(RP_MIN_SAVED, w); },
  });
}

// Inline status pattern used throughout the app (spoofStatus, secStatus,
// rp-run-status) instead of blocking alert()/prompt() dialogs.
function showFormStatus(msg, isError) {
  const el = document.getElementById('rpFormStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('rp-form-status-error', !!isError);
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 4000);
}

// ─── Recording ─────────────────────────────────────────────────────────────

async function startRecording() {
  if (!getActiveId()) { showFormStatus('No active session', true); return; }
  isRecording = true;
  currentSteps = [];
  setRecordBtns(true);
  renderLiveSteps();
  await testerBrowser.tests.startRecording(getActiveId());
  pollInterval = setInterval(async () => {
    if (!isRecording) return;
    const steps = await testerBrowser.tests.pollRecordingSteps(getActiveId());
    currentSteps = steps || [];
    renderLiveSteps();
  }, 600);
}

async function stopRecording() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  isRecording = false;
  const steps = await testerBrowser.tests.stopRecording(getActiveId());
  currentSteps = steps || [];
  setRecordBtns(false);
  renderLiveSteps();
}

function discardRecording() {
  currentSteps = [];
  isRecording = false;
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  setRecordBtns(false);
  renderLiveSteps();
}

async function saveRecordedTest() {
  const name = document.getElementById('rpTestName').value.trim() || ('Test ' + new Date().toLocaleString());
  if (currentSteps.length === 0) { showFormStatus('No steps recorded', true); return; }
  const test = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    name,
    steps: currentSteps,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await testerBrowser.tests.save(test);
  currentSteps = [];
  document.getElementById('rpTestName').value = '';
  setRecordBtns(false);
  renderLiveSteps();
  await refreshTestList();
}

function setRecordBtns(recording) {
  document.getElementById('rpStartBtn').disabled = recording;
  document.getElementById('rpStopBtn').disabled = !recording;
  document.getElementById('rpSaveBtn').disabled = recording || currentSteps.length === 0;
  document.getElementById('rpDiscardBtn').disabled = recording || currentSteps.length === 0;
}

function renderLiveSteps() {
  const el = document.getElementById('rpLiveSteps');
  if (!el) return;
  if (currentSteps.length === 0) {
    el.innerHTML = isRecording ? '<div class="rp-hint">Recording… interact with the page</div>' : '';
    return;
  }
  el.innerHTML = currentSteps.map((s, i) => `
    <div class="rp-live-step" data-idx="${i}" title="Right-click to add assertion after this step">
      <span class="rp-step-num">${i + 1}</span>
      ${s.selector ? `<span class="rp-confidence-dot rp-confidence-pending" data-selector-idx="${i}" title="Checking selector…"></span>` : ''}
      ${stepRowFieldsHtml(s, i, false)}
      <button class="rp-del-step" data-idx="${i}" title="Remove step">×</button>
    </div>
  `).join('');

  el.querySelectorAll('.rp-live-step').forEach(row => {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showAssertionMenu(parseInt(row.dataset.idx, 10), e.clientX, e.clientY);
    });
  });
  el.querySelectorAll('.rp-del-step').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      currentSteps.splice(idx, 1);
      renderLiveSteps();
    });
  });

  document.getElementById('rpSaveBtn').disabled = isRecording || currentSteps.length === 0;
  document.getElementById('rpDiscardBtn').disabled = isRecording || currentSteps.length === 0;

  refreshSelectorConfidence();
}

// Shared row content (everything between the step number/confidence dot and
// the delete button) for both the live-recording buffer (read-only spans)
// and a saved test's expanded, editable step list (inputs/select) — so the
// two views of the same TestStep object stay visually consistent instead of
// drifting into separate markup. `editable` false renders the original
// read-only spans (.rp-step-type / .rp-step-desc / .rp-step-val) unchanged;
// `editable` true renders a type <select> plus selector/url/attr/value
// <input>s, constrained to the fields sessionManager's buildPlaybackScript
// actually understands for that step's type (STEP_TYPE_DEFS).
function stepRowFieldsHtml(step, idx, editable) {
  const isAssertType = step.type.startsWith('assert');
  if (!editable) {
    return `
      <span class="rp-step-type ${isAssertType ? 'rp-type-assert' : ''}">${step.type}</span>
      <span class="rp-step-desc">${escHtml(step.selector || step.url || step.description || '')}</span>
      ${step.value && !step.sensitive ? `<span class="rp-step-val">${escHtml(String(step.value).slice(0, 40))}</span>` : ''}
      ${step.sensitive ? '<span class="rp-step-val">[hidden]</span>' : ''}
    `;
  }
  const def = STEP_TYPE_DEFS[step.type] || {};
  const typeOptions = Object.keys(STEP_TYPE_DEFS)
    .map(t => `<option value="${t}" ${t === step.type ? 'selected' : ''}>${t}</option>`)
    .join('');
  const showSelectorInput = def.needsSelector || def.needsUrl;
  const selectorField = def.needsUrl ? 'url' : 'selector';
  const selectorValue = def.needsUrl ? (step.url || '') : (step.selector || '');
  return `
    <select class="rp-input rp-step-type rp-step-field" data-step-idx="${idx}" data-field="type">${typeOptions}</select>
    ${showSelectorInput
      ? `<input class="rp-input rp-step-desc rp-step-field" data-step-idx="${idx}" data-field="${selectorField}" value="${escHtml(selectorValue)}" placeholder="${def.needsUrl ? 'URL' : 'CSS selector'}" />`
      : '<span class="rp-step-desc"></span>'}
    ${def.needsAttr
      ? `<input class="rp-input rp-step-val rp-step-field" data-step-idx="${idx}" data-field="attr" value="${escHtml(step.attr || '')}" placeholder="Attribute" />`
      : ''}
    ${def.needsValue
      ? `<input class="rp-input rp-step-val rp-step-field" data-step-idx="${idx}" data-field="value" value="${step.sensitive ? '' : escHtml(step.value || '')}" placeholder="${step.sensitive ? '[hidden] — type to replace' : (def.valuePlaceholder || 'Value')}" />`
      : ''}
    <button class="rp-saved-step-del" data-step-idx="${idx}" title="Delete step">×</button>
  `;
}

// ─── Selector confidence ────────────────────────────────────────────────────
// For each live-recorded step with a selector, queries how many elements on
// the current page it matches, so a fragile selector (0 = broken, 2+ =
// ambiguous) is visible while recording rather than discovered later at
// playback time. Exported so ipc-events.js's session:navigated handler (the
// one place allowed to call testerBrowser.sessions.onNavigated — it's a
// single-listener IPC binding) can trigger a re-check after navigation.
export async function refreshSelectorConfidence() {
  const el = document.getElementById('rpLiveSteps');
  if (!el || !getActiveId()) return;
  const dots = [...el.querySelectorAll('.rp-confidence-dot')];
  for (const dot of dots) {
    const idx = parseInt(dot.dataset.selectorIdx, 10);
    const step = currentSteps[idx];
    if (!step?.selector) continue;
    const count = await testerBrowser.tests.countSelectorMatches(getActiveId(), step.selector).catch(() => -1);
    // The steps list (and thus the DOM) may have changed while this awaited.
    if (!document.body.contains(dot)) continue;
    dot.classList.remove('rp-confidence-pending');
    if (count === 1) {
      dot.classList.add('rp-confidence-green');
      dot.title = '1 match — unique and reliable';
    } else if (count >= 2 && count <= 5) {
      dot.classList.add('rp-confidence-yellow');
      dot.title = `${count} matches — ambiguous, may click the wrong element`;
    } else {
      dot.classList.add('rp-confidence-red');
      dot.title = count === 0 ? '0 matches — selector is broken on this page'
        : count > 5 ? `${count} matches — too broad`
        : 'Invalid selector or page unavailable';
    }
  }
}

// ─── Assertion insertion ─────────────────────────────────────────────────────

const ASSERT_TYPES = [
  { type: 'assert-visible',     label: 'Assert: element visible',      needsSelector: true,  needsValue: false },
  { type: 'assert-not-visible', label: 'Assert: element not visible',  needsSelector: true,  needsValue: false },
  { type: 'assert-text',        label: 'Assert: element contains text', needsSelector: true,  needsValue: true,  valuePlaceholder: 'Expected text' },
  { type: 'assert-value',       label: 'Assert: input has value',      needsSelector: true,  needsValue: true,  valuePlaceholder: 'Expected value' },
  { type: 'assert-url',         label: 'Assert: URL contains',         needsSelector: false, needsValue: true,  valuePlaceholder: 'URL substring' },
  { type: 'assert-enabled',     label: 'Assert: element enabled',      needsSelector: true,  needsValue: false },
  { type: 'assert-attr',        label: 'Assert: attribute equals',     needsSelector: true,  needsValue: true,  needsAttr: true, valuePlaceholder: 'Expected value' },
  { type: 'wait-visible',       label: 'Wait: element visible',        needsSelector: true,  needsValue: false },
];

// The full set of step types the playback engine (sessionManager's
// buildPlaybackScript) actually understands, for the saved-test step editor's
// type dropdown — a constrained choice rather than free text that would fail
// at run time. Built from ASSERT_TYPES plus the non-assertion action types.
const STEP_TYPE_DEFS = {
  navigate: { needsSelector: false, needsUrl: true, needsValue: false },
  click:    { needsSelector: true,  needsValue: false },
  fill:     { needsSelector: true,  needsValue: true, valuePlaceholder: 'Value to type' },
  ...Object.fromEntries(ASSERT_TYPES.map(a => [a.type, { needsSelector: a.needsSelector, needsValue: a.needsValue, needsAttr: a.needsAttr, valuePlaceholder: a.valuePlaceholder }])),
  'wait-navigation': { needsSelector: false, needsValue: false },
};

let assertMenuInsertIdx = -1;

function showAssertionMenu(afterIdx, x, y) {
  removeAssertionMenu();
  assertMenuInsertIdx = afterIdx;

  const menu = document.createElement('div');
  menu.id = 'rpAssertMenu';
  menu.className = 'rp-assert-menu';
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9999`;
  menu.innerHTML = `
    <div class="rp-assert-menu-title">Add assertion after step ${afterIdx + 1}</div>
    ${ASSERT_TYPES.map((a, i) => `<div class="rp-assert-menu-item" data-i="${i}">${a.label}</div>`).join('')}
  `;
  document.body.appendChild(menu);

  menu.querySelectorAll('.rp-assert-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const def = ASSERT_TYPES[parseInt(item.dataset.i, 10)];
      removeAssertionMenu();
      showAssertionDialog(assertMenuInsertIdx, def);
    });
  });

  setTimeout(() => document.addEventListener('click', removeAssertionMenu, { once: true }), 0);
}

function removeAssertionMenu() {
  document.getElementById('rpAssertMenu')?.remove();
}

function showAssertionDialog(afterIdx, def) {
  removeAssertionDialog();
  const dlg = document.createElement('div');
  dlg.id = 'rpAssertDlg';
  dlg.className = 'rp-assert-dlg';
  dlg.innerHTML = `
    <div class="rp-assert-dlg-inner">
      <div class="rp-assert-dlg-title">${def.label}</div>
      ${def.needsSelector ? `<input class="rp-input" id="rpAssertSel" placeholder="CSS selector" />` : ''}
      ${def.needsAttr     ? `<input class="rp-input" id="rpAssertAttr" placeholder="Attribute name" />` : ''}
      ${def.needsValue    ? `<input class="rp-input" id="rpAssertVal" placeholder="${def.valuePlaceholder || 'Value'}" />` : ''}
      <span class="rp-assert-dlg-status" id="rpAssertDlgStatus"></span>
      <div class="rp-assert-dlg-btns">
        <button class="rp-btn" id="rpAssertOk">Add</button>
        <button class="rp-btn" id="rpAssertCancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);

  document.getElementById('rpAssertOk').addEventListener('click', () => {
    const selector  = def.needsSelector ? (document.getElementById('rpAssertSel')?.value.trim() || '') : undefined;
    const attr      = def.needsAttr     ? (document.getElementById('rpAssertAttr')?.value.trim() || '') : undefined;
    const value     = def.needsValue    ? (document.getElementById('rpAssertVal')?.value.trim() || '') : undefined;
    const dlgStatus = document.getElementById('rpAssertDlgStatus');
    if (def.needsSelector && !selector) { dlgStatus.textContent = 'Selector required'; return; }
    if (def.needsValue    && !value)    { dlgStatus.textContent = 'Value required'; return; }

    const step = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      type: def.type,
      selector,
      value,
      attr,
      timestamp: Date.now(),
      description: def.label,
    };
    currentSteps.splice(afterIdx + 1, 0, step);
    removeAssertionDialog();
    renderLiveSteps();
  });

  document.getElementById('rpAssertCancel').addEventListener('click', removeAssertionDialog);
  document.getElementById('rpAssertSel')?.focus();
}

function removeAssertionDialog() {
  document.getElementById('rpAssertDlg')?.remove();
}

// ─── Test list ──────────────────────────────────────────────────────────────

// Which saved test's steps are currently expanded for editing — module-level
// so a re-render (after an edit's autosave) can keep it open instead of
// collapsing the panel the user is actively working in.
let expandedTestId = null;

async function refreshTestList() {
  try { savedTests = (await testerBrowser.tests.list()) || []; } catch { savedTests = []; }
  if (!savedTests.some(t => t.id === expandedTestId)) expandedTestId = null;
  renderTestList();
}

function renderTestList() {
  const el = document.getElementById('rpTestList');
  if (!el) return;
  if (savedTests.length === 0) {
    el.innerHTML = '<div class="rp-hint">Click Record to start capturing browser interactions.</div>';
    return;
  }
  el.innerHTML = savedTests.map(t => `
    <div class="rp-test-item" data-id="${t.id}">
      <div class="rp-test-header">
        <button class="rp-test-expand" data-id="${t.id}" title="${t.id === expandedTestId ? 'Collapse' : 'Expand to view/edit steps'}">${t.id === expandedTestId ? '▾' : '▸'}</button>
        <div class="rp-test-name">${escHtml(t.name)}</div>
      </div>
      <div class="rp-test-meta">${t.steps.length} steps</div>
      <div class="rp-test-actions">
        <button class="rp-btn rp-btn-sm rp-run-once" data-id="${t.id}">Run</button>
        <input class="rp-input rp-repeat-input" type="number" min="1" max="500" value="10" data-id="${t.id}" title="Number of times to run" />
        <button class="rp-btn rp-btn-sm rp-run-many" data-id="${t.id}">Run N×</button>
        <button class="rp-btn rp-btn-sm rp-btn-del" data-id="${t.id}">&#10005;</button>
      </div>
      ${t.id === expandedTestId ? `<div class="rp-saved-steps" id="rpSavedSteps-${t.id}">${renderSavedStepsHtml(t)}</div>` : ''}
    </div>
  `).join('');

  el.querySelectorAll('.rp-test-expand').forEach(btn => {
    btn.addEventListener('click', () => {
      expandedTestId = expandedTestId === btn.dataset.id ? null : btn.dataset.id;
      renderTestList();
    });
  });
  if (expandedTestId) wireSavedStepEditors(savedTests.find(t => t.id === expandedTestId));

  el.querySelectorAll('.rp-run-once').forEach(btn => {
    btn.addEventListener('click', () => runTest(btn.dataset.id, 1));
  });
  el.querySelectorAll('.rp-repeat-input').forEach(input => {
    input.addEventListener('input', () => input.classList.remove('rp-input-invalid'));
  });
  el.querySelectorAll('.rp-run-many').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = el.querySelector(`.rp-repeat-input[data-id="${btn.dataset.id}"]`);
      const n = parseInt(input.value, 10);
      if (!Number.isFinite(n) || n < 1) {
        input.classList.add('rp-input-invalid');
        input.focus();
        return;
      }
      input.classList.remove('rp-input-invalid');
      const clamped = Math.min(n, 500);
      input.value = String(clamped);
      runTest(btn.dataset.id, clamped);
    });
  });
  el.querySelectorAll('.rp-btn-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      await testerBrowser.tests.delete(btn.dataset.id);
      await refreshTestList();
    });
  });
}

// Renders one saved test's steps as editable rows (reusing the shared
// .rp-live-step row shell and stepRowFieldsHtml's editable branch), plus a
// per-step delete button distinct from both the live-recording buffer's
// .rp-del-step and the whole-test .rp-btn-del above, to avoid any class
// collision between the three different "delete" actions.
function renderSavedStepsHtml(test) {
  if (test.steps.length === 0) return '<div class="rp-hint">No steps.</div>';
  return test.steps.map((s, i) => `
    <div class="rp-live-step" data-step-idx="${i}">
      <span class="rp-step-num">${i + 1}</span>
      ${stepRowFieldsHtml(s, i, true)}
    </div>
  `).join('');
}

function wireSavedStepEditors(test) {
  if (!test) return;
  const container = document.getElementById(`rpSavedSteps-${test.id}`);
  if (!container) return;

  container.querySelectorAll('.rp-step-field').forEach(field => {
    field.addEventListener('change', () => handleSavedStepFieldChange(test, field));
  });
  container.querySelectorAll('.rp-saved-step-del').forEach(btn => {
    btn.addEventListener('click', () => handleSavedStepDelete(test, parseInt(btn.dataset.stepIdx, 10)));
  });
}

async function handleSavedStepFieldChange(test, field) {
  const idx = parseInt(field.dataset.stepIdx, 10);
  const step = test.steps[idx];
  if (!step) return;

  if (field.dataset.field === 'type') {
    step.type = field.value;
    // Clear whichever fields the new type doesn't use, so a stale selector
    // from before a type change (e.g. click → assert-url) doesn't silently
    // linger unused, or worse, get re-used if the type is changed back.
    const def = STEP_TYPE_DEFS[step.type] || {};
    if (!def.needsSelector) delete step.selector;
    if (!def.needsUrl) delete step.url;
    if (!def.needsAttr) delete step.attr;
    if (!def.needsValue) { delete step.value; step.sensitive = false; }
  } else if (field.dataset.field === 'value') {
    // A sensitive step's value field is rendered empty (masked); leaving it
    // empty and blurring away must not overwrite the real value with ''.
    // Only a non-empty edit replaces it — and it stays sensitive/masked.
    if (step.sensitive && field.value === '') {
      // untouched — keep the existing (masked) value
    } else {
      step.value = field.value;
    }
  } else {
    step[field.dataset.field] = field.value;
  }

  await persistSavedTest(test);
  renderTestList();
}

async function handleSavedStepDelete(test, idx) {
  test.steps.splice(idx, 1);
  await persistSavedTest(test);
  renderTestList();
}

async function persistSavedTest(test) {
  test.updatedAt = Date.now();
  await testerBrowser.tests.save(test);
}

// ─── Playback ───────────────────────────────────────────────────────────────

function waitForStepAdvance() {
  document.getElementById('rpStepControls').hidden = false;
  return new Promise((resolve) => { stepAdvance = resolve; });
}

function resolveStepAdvance(action) {
  if (!stepAdvance) return;
  document.getElementById('rpStepControls').hidden = true;
  const resolve = stepAdvance;
  stepAdvance = null;
  if (action === 'stop') stepStopped = true;
  resolve(action);
}

async function runTest(testId, runCount) {
  const test = savedTests.find(t => t.id === testId);
  if (!test) return;
  if (!getActiveId()) { showFormStatus('No active session', true); return; }

  const runView = document.getElementById('rpRunView');
  const placeholder = document.getElementById('rpRunPlaceholder');
  runView.hidden = false;
  placeholder.hidden = true;

  document.getElementById('rpRunTitle').textContent = test.name + (runCount > 1 ? ` (0/${runCount})` : '');
  document.getElementById('rpRunStatus').textContent = 'Starting…';
  document.getElementById('rpProgressFill').style.width = '0%';
  document.getElementById('rpStepsList').innerHTML = '';
  document.getElementById('rpRepeatResults').hidden = true;
  document.getElementById('rpStepControls').hidden = true;

  // Step-by-step only makes sense for a single run — Run N× is for flake
  // detection and always executes straight through regardless of the toggle.
  const stepByStep = runCount === 1 && document.getElementById('rpStepModeToggle').checked;
  stepStopped = false;

  const allRunResults = [];
  let passed = 0;
  let failed = 0;

  for (let run = 0; run < runCount; run++) {
    if (runCount > 1) {
      document.getElementById('rpRunTitle').textContent = `${test.name} (${run + 1}/${runCount})`;
    }
    // Repeat runs otherwise execute back-to-back with no reset in between —
    // if the test's own first step isn't a navigate, run 2..N would run
    // against whatever DOM state the previous run left behind, producing
    // false FLAKY verdicts that are really state bleed, not real flakiness.
    // This reloads whatever URL is *currently* active, not necessarily the
    // test's original recorded start URL, so a multi-page test won't be
    // fully reset by a plain reload — an accepted scope limit for now.
    if (run > 0 && test.steps[0]?.type !== 'navigate') {
      await testerBrowser.sessions.reload(getActiveId());
    }
    const result = await executeTest(test, runCount > 1, stepByStep);
    allRunResults.push(result);
    if (result.passed) passed++; else failed++;
    if (runCount > 1) {
      document.getElementById('rpProgressFill').style.width = `${Math.round((run + 1) / runCount * 100)}%`;
    }
  }

  if (runCount > 1) {
    showRepeatResults(test, allRunResults, passed, failed, runCount);
  }
}

async function executeTest(test, silent, stepByStep = false) {
  const sessionId = getActiveId();
  const stepEls = document.getElementById('rpStepsList');
  if (!silent) stepEls.innerHTML = '';

  const stepResults = [];
  let failed = false;
  let stopped = false;
  let currentRow = null;

  for (let i = 0; i < test.steps.length; i++) {
    const step = test.steps[i];
    const pct = Math.round((i / test.steps.length) * 100);
    document.getElementById('rpProgressFill').style.width = `${pct}%`;
    document.getElementById('rpRunStatus').textContent = `Step ${i + 1}/${test.steps.length}: ${step.type} ${step.selector || step.url || ''}`;

    if (!silent) {
      const row = document.createElement('div');
      row.className = 'rp-step-row rp-step-running';
      row.innerHTML = `<span class="rp-step-num">${i + 1}</span><span class="rp-step-type">${step.type}</span><span class="rp-step-desc">${escHtml(step.selector || step.url || step.description || '')}</span><span class="rp-step-status">…</span>`;
      stepEls.appendChild(row);
      stepEls.scrollTop = stepEls.scrollHeight;

      const result = await testerBrowser.tests.playbackStep(sessionId, step);
      row.classList.remove('rp-step-running');
      row.classList.add(result.success ? 'rp-step-pass' : 'rp-step-fail');
      row.querySelector('.rp-step-status').textContent = result.success ? '✓' : ('✗ ' + (result.error || ''));

      currentRow?.classList.remove('rp-step-current');
      row.classList.add('rp-step-current');
      currentRow = row;

      stepResults.push({ step: i + 1, type: step.type, selector: step.selector, success: result.success, error: result.error });
      if (!result.success) {
        failed = true;
        document.getElementById('rpRunStatus').textContent = `Failed at step ${i + 1}: ${result.error || ''}`;
        document.getElementById('rpProgressFill').style.width = '100%';

        const shot = await testerBrowser.tests.captureScreenshot(sessionId);
        if (shot) {
          const img = document.createElement('img');
          img.src = `data:image/png;base64,${shot}`;
          img.className = 'rp-failure-shot';
          stepEls.appendChild(img);
        }
        break;
      }

      // Pause after every step but the last — nothing left to advance to
      // once the final step has already run.
      if (stepByStep && i < test.steps.length - 1) {
        document.getElementById('rpRunStatus').textContent =
          `Paused after step ${i + 1}/${test.steps.length} — click Next to continue`;
        const action = await waitForStepAdvance();
        if (action === 'stop' || stepStopped) { stopped = true; break; }
      }
    } else {
      const result = await testerBrowser.tests.playbackStep(sessionId, step);
      stepResults.push({ step: i + 1, type: step.type, selector: step.selector, success: result.success, error: result.error });
      if (!result.success) { failed = true; break; }
    }
  }

  if (stopped) {
    document.getElementById('rpRunStatus').textContent = `Stopped after step ${stepResults.length}/${test.steps.length}`;
  } else if (!failed && !silent) {
    document.getElementById('rpProgressFill').style.width = '100%';
    document.getElementById('rpRunStatus').textContent = 'All steps passed ✓';
  }

  return { passed: !failed && !stopped, stepResults, stopped };
}

function showRepeatResults(test, allRunResults, passed, failed, total) {
  const pct = Math.round((passed / total) * 100);
  const isFlaky = passed < total && passed > 0;
  const status = passed === total ? 'STABLE' : (passed === 0 ? 'FAILING' : 'FLAKY');

  const stepFailMap = {};
  for (const run of allRunResults) {
    for (const sr of run.stepResults) {
      if (!sr.success) {
        const key = `Step ${sr.step} (${sr.type}${sr.selector ? ' ' + sr.selector : ''})`;
        if (!stepFailMap[key]) stepFailMap[key] = { count: 0, errors: [] };
        stepFailMap[key].count++;
        if (sr.error) stepFailMap[key].errors.push(sr.error);
      }
    }
  }

  const failedRunIndices = allRunResults.map((r, i) => r.passed ? null : i + 1).filter(x => x !== null);

  const el = document.getElementById('rpRepeatResults');
  el.hidden = false;
  el.innerHTML = `
    <div class="rp-repeat-header ${isFlaky ? 'rp-flaky' : (passed === total ? 'rp-stable' : 'rp-failing')}">
      ${test.name} — ${status}
    </div>
    <div class="rp-repeat-summary">
      <span>Runs: <b>${total}</b></span>
      <span>Passed: <b>${passed}</b></span>
      <span>Failed: <b>${failed}</b></span>
      <span>Pass rate: <b>${pct}%</b></span>
    </div>
    ${Object.keys(stepFailMap).length > 0 ? `
      <table class="rp-fail-table">
        <thead><tr><th>Step</th><th>Failures</th><th>Sample error</th></tr></thead>
        <tbody>
          ${Object.entries(stepFailMap).map(([k, v]) => `
            <tr><td>${escHtml(k)}</td><td>${v.count}</td><td>${escHtml((v.errors[0] || '').slice(0, 80))}</td></tr>
          `).join('')}
        </tbody>
      </table>
    ` : ''}
    ${failedRunIndices.length > 0 ? `
      <div class="rp-failed-runs">Failed runs: ${failedRunIndices.join(', ')}
        ${failedRunIndices.length > 0 ? `<button class="rp-btn rp-btn-sm" id="rpReplayFailed" data-run="${failedRunIndices[0]}">Replay Run #${failedRunIndices[0]}</button>` : ''}
      </div>
    ` : ''}
  `;

  document.getElementById('rpRunStatus').textContent = `${status}: ${passed}/${total} passed (${pct}%)`;
  document.getElementById('rpProgressFill').style.width = '100%';

  const replayBtn = document.getElementById('rpReplayFailed');
  if (replayBtn) {
    replayBtn.addEventListener('click', () => { runTest(test.id, 1); });
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

