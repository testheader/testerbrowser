/* global testerBrowser */
import { state } from './state.js';

let initialized = false;
let isRecording = false;
let pollInterval = null;
let currentSteps = [];
let savedTests = [];

export function initRecordPlayback() {
  const panel = document.getElementById('testsPanel');
  if (initialized) { refreshTestList(); return; }
  initialized = true;

  panel.innerHTML = `
    <div class="rp-wrap">
      <div class="rp-sidebar">
        <div class="rp-section-title">Record New Test</div>
        <div class="rp-record-form">
          <input class="rp-input" id="rpTestName" type="text" placeholder="Test name…" />
          <div class="rp-record-btns">
            <button class="rp-btn rp-btn-record" id="rpStartBtn">&#9679; Start</button>
            <button class="rp-btn rp-btn-stop" id="rpStopBtn" disabled>&#9632; Stop</button>
            <button class="rp-btn" id="rpSaveBtn" disabled>Save</button>
            <button class="rp-btn" id="rpDiscardBtn" disabled>Discard</button>
          </div>
        </div>
        <div id="rpLiveSteps" class="rp-live-steps"></div>

        <div class="rp-section-title" style="margin-top:12px">Saved Tests</div>
        <div id="rpTestList" class="rp-test-list"></div>
      </div>

      <div class="rp-main">
        <div id="rpRunView" class="rp-run-view" hidden>
          <div class="rp-run-header">
            <span id="rpRunTitle" class="rp-run-title"></span>
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

  document.getElementById('rpStartBtn').addEventListener('click', startRecording);
  document.getElementById('rpStopBtn').addEventListener('click', stopRecording);
  document.getElementById('rpSaveBtn').addEventListener('click', saveRecordedTest);
  document.getElementById('rpDiscardBtn').addEventListener('click', discardRecording);
  document.getElementById('rpRunClose').addEventListener('click', () => {
    document.getElementById('rpRunView').hidden = true;
    document.getElementById('rpRunPlaceholder').hidden = false;
  });

  refreshTestList();
}

// ─── Recording ─────────────────────────────────────────────────────────────

async function startRecording() {
  if (!state.activeId) { alert('No active session'); return; }
  isRecording = true;
  currentSteps = [];
  setRecordBtns(true);
  renderLiveSteps();
  await testerBrowser.tests.startRecording(state.activeId);
  pollInterval = setInterval(async () => {
    if (!isRecording) return;
    const steps = await testerBrowser.tests.pollRecordingSteps(state.activeId);
    currentSteps = steps || [];
    renderLiveSteps();
  }, 600);
}

async function stopRecording() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  isRecording = false;
  const steps = await testerBrowser.tests.stopRecording(state.activeId);
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
  if (currentSteps.length === 0) { alert('No steps recorded'); return; }
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
      <span class="rp-step-type ${s.type.startsWith('assert') ? 'rp-type-assert' : ''}">${s.type}</span>
      <span class="rp-step-desc">${escHtml(s.selector || s.url || s.description || '')}</span>
      ${s.value && !s.sensitive ? `<span class="rp-step-val">${escHtml(String(s.value).slice(0, 40))}</span>` : ''}
      ${s.sensitive ? '<span class="rp-step-val">[hidden]</span>' : ''}
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
    if (def.needsSelector && !selector) { alert('Selector required'); return; }
    if (def.needsValue    && !value)    { alert('Value required'); return; }

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

async function refreshTestList() {
  try { savedTests = (await testerBrowser.tests.list()) || []; } catch { savedTests = []; }
  const el = document.getElementById('rpTestList');
  if (!el) return;
  if (savedTests.length === 0) {
    el.innerHTML = '<div class="rp-hint">Click Record to start capturing browser interactions.</div>';
    return;
  }
  el.innerHTML = savedTests.map(t => `
    <div class="rp-test-item" data-id="${t.id}">
      <div class="rp-test-name">${escHtml(t.name)}</div>
      <div class="rp-test-meta">${t.steps.length} steps</div>
      <div class="rp-test-actions">
        <button class="rp-btn rp-btn-sm rp-run-once" data-id="${t.id}">Run</button>
        <button class="rp-btn rp-btn-sm rp-run-many" data-id="${t.id}">Run N×</button>
        <button class="rp-btn rp-btn-sm rp-btn-del" data-id="${t.id}">&#10005;</button>
      </div>
    </div>
  `).join('');

  el.querySelectorAll('.rp-run-once').forEach(btn => {
    btn.addEventListener('click', () => runTest(btn.dataset.id, 1));
  });
  el.querySelectorAll('.rp-run-many').forEach(btn => {
    btn.addEventListener('click', () => promptRepeatRun(btn.dataset.id));
  });
  el.querySelectorAll('.rp-btn-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      await testerBrowser.tests.delete(btn.dataset.id);
      await refreshTestList();
    });
  });
}

function promptRepeatRun(testId) {
  const test = savedTests.find(t => t.id === testId);
  if (!test) return;
  const options = ['10', '50', '100', 'Custom'];
  const choice = window.prompt(`Run "${test.name}" how many times?\n${options.slice(0, 3).join(' / ')} / Custom`);
  if (!choice) return;
  const n = parseInt(choice, 10);
  if (!n || n < 1) { alert('Invalid number'); return; }
  runTest(testId, Math.min(n, 500));
}

// ─── Playback ───────────────────────────────────────────────────────────────

async function runTest(testId, runCount) {
  const test = savedTests.find(t => t.id === testId);
  if (!test) return;
  if (!state.activeId) { alert('No active session'); return; }

  const runView = document.getElementById('rpRunView');
  const placeholder = document.getElementById('rpRunPlaceholder');
  runView.hidden = false;
  placeholder.hidden = true;

  document.getElementById('rpRunTitle').textContent = test.name + (runCount > 1 ? ` (0/${runCount})` : '');
  document.getElementById('rpRunStatus').textContent = 'Starting…';
  document.getElementById('rpProgressFill').style.width = '0%';
  document.getElementById('rpStepsList').innerHTML = '';
  document.getElementById('rpRepeatResults').hidden = true;

  const allRunResults = [];
  let passed = 0;
  let failed = 0;

  for (let run = 0; run < runCount; run++) {
    if (runCount > 1) {
      document.getElementById('rpRunTitle').textContent = `${test.name} (${run + 1}/${runCount})`;
    }
    const result = await executeTest(test, runCount > 1);
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

async function executeTest(test, silent) {
  const sessionId = state.activeId;
  const stepEls = document.getElementById('rpStepsList');
  if (!silent) stepEls.innerHTML = '';

  const stepResults = [];
  let failed = false;

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
    } else {
      const result = await testerBrowser.tests.playbackStep(sessionId, step);
      stepResults.push({ step: i + 1, type: step.type, selector: step.selector, success: result.success, error: result.error });
      if (!result.success) { failed = true; break; }
    }
  }

  if (!failed && !silent) {
    document.getElementById('rpProgressFill').style.width = '100%';
    document.getElementById('rpRunStatus').textContent = 'All steps passed ✓';
  }

  return { passed: !failed, stepResults };
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

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
