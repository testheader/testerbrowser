/* global testerBrowser */
import { escHtml, MOCK_STRIPPED_RESPONSE_HEADERS, formatAgo } from './utils.js';
import { renderEmptyState } from './empty-state.js';
import { getActiveId } from './tabs.js';
import { getActiveConsoleTab, switchConsoleTab } from './console-tabs.js';
import { addKvRow, readKvTable } from './kv-table.js';
import { pollWhileVisible } from './poll.js';
import { MOCK_STEP_COUNT, isMockStepValid, summarizeMockRule } from './mock-logic.js';

const MOCK_METHODS = ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Request headers from the captured call the form is currently prefilled
// from — read-only provenance shown in the panel, never submitted as
// anything matching runs against. Reset on every prefill and after submit;
// stays null for a rule composed by hand rather than from a real request.
let capturedRequestHeaders = null;

function renderCapturedRequestHeaders() {
  const col  = document.getElementById('mockRequestHeadersCol');
  const list = document.getElementById('mockRequestHeadersList');
  if (!col || !list) return;
  const entries = Object.entries(capturedRequestHeaders || {});
  col.hidden = entries.length === 0;
  list.innerHTML = entries
    .map(([k, v]) => `<div class="mock-request-header-row"><span class="mock-request-header-key">${escHtml(k)}</span>: ${escHtml(String(v))}</div>`)
    .join('');
}

// Entry point for the "⇒ Mock" button on a network request's detail panel:
// switches to the Mock tab and prefills the add-rule form with everything
// needed to reproduce that call's response — method, URL, status, request
// headers (read-only provenance), response headers and body — so the user
// doesn't have to retype them.
export function openMockFromRequest(method, url, statusCode, body, opts = {}) {
  switchConsoleTab('mock'); // also runs initMock() if this is the first visit
  const urlInput    = /** @type {HTMLInputElement} */ (document.getElementById('mockUrl'));
  const methodSel   = /** @type {HTMLSelectElement} */ (document.getElementById('mockMethod'));
  const statusInput = /** @type {HTMLInputElement} */ (document.getElementById('mockStatus'));
  const bodyInput   = /** @type {HTMLTextAreaElement} */ (document.getElementById('mockBody'));
  const bodyNote    = document.getElementById('mockBodyNote');
  const resHeaders  = document.getElementById('mockResponseHeadersTable');
  if (!urlInput || !methodSel) return;
  urlInput.value  = url || '';
  methodSel.value = MOCK_METHODS.includes(method) ? method : '*';
  if (statusInput && statusCode) statusInput.value = statusCode;
  if (bodyInput) bodyInput.value = body || '';
  if (bodyNote) bodyNote.hidden = !opts.bodyUnavailable;

  if (resHeaders) {
    resHeaders.innerHTML = '';
    for (const [k, v] of Object.entries(opts.responseHeaders || {})) {
      // The captured call's own encoding headers describe the original,
      // often-compressed body — fulfilling with them still attached corrupts
      // or truncates the decoded (possibly edited) body actually sent.
      if (MOCK_STRIPPED_RESPONSE_HEADERS.includes(k.toLowerCase())) continue;
      addKvRow(resHeaders, k, v);
    }
  }

  capturedRequestHeaders = opts.requestHeaders || null;
  renderCapturedRequestHeaders();

  // Prefilled from a real call: land on the last step with the summary showing.
  setMockFormOpen(true, MOCK_STEP_COUNT);
}

// #310: the add-rule form is inline and closed by default — New rule opens it,
// as does "Mock" on a captured request; Cancel / Add rule close it again.
function setMockFormOpen(open, step = 1) {
  const form = document.getElementById('mockForm');
  if (form) form.hidden = !open;
  document.getElementById('mockNewRuleBtn')?.setAttribute('aria-pressed', String(open));
  if (open) showMockStep(step);
}

// #355: the add-rule form is a 2-step stepper inside the card — request (URL
// pattern + method), then response (status, delay, body, headers, CORS) with
// the summary line and the Add rule button. Step state is renderer-only; every
// field keeps its id and the rule payload is unchanged.
let mockStep = 1;

function mockFieldValues() {
  const val = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id)).value;
  return { urlPattern: val('mockUrl'), status: val('mockStatus'), method: val('mockMethod') };
}

function showMockStep(step) {
  mockStep = Math.min(MOCK_STEP_COUNT, Math.max(1, step));
  document.querySelectorAll('#mockForm .mock-step').forEach(el => {
    /** @type {HTMLElement} */ (el).hidden = Number(/** @type {HTMLElement} */ (el).dataset.step) !== mockStep;
  });
  document.getElementById('mockStepIndicator').textContent = `Step ${mockStep} of ${MOCK_STEP_COUNT}`;
  /** @type {HTMLElement} */ (document.getElementById('mockBackBtn')).hidden = mockStep === 1;
  /** @type {HTMLElement} */ (document.getElementById('mockNextBtn')).hidden = mockStep === MOCK_STEP_COUNT;
  /** @type {HTMLElement} */ (document.getElementById('mockAddBtn')).hidden = mockStep !== MOCK_STEP_COUNT;
  updateMockStepState();
  document.getElementById(mockStep === 1 ? 'mockUrl' : 'mockStatus').focus();
}

function updateMockStepState() {
  const v = mockFieldValues();
  /** @type {HTMLButtonElement} */ (document.getElementById('mockNextBtn')).disabled = !isMockStepValid(mockStep, v);
  /** @type {HTMLButtonElement} */ (document.getElementById('mockAddBtn')).disabled =
    !(isMockStepValid(1, v) && isMockStepValid(2, v));
  document.getElementById('mockSummary').textContent = summarizeMockRule(v);
}

function advanceMockStep() {
  if (mockStep < MOCK_STEP_COUNT && isMockStepValid(mockStep, mockFieldValues())) showMockStep(mockStep + 1);
}

function resetMockForm() {
  /** @type {HTMLInputElement} */ (document.getElementById('mockUrl')).value  = '';
  /** @type {HTMLSelectElement} */ (document.getElementById('mockMethod')).value = '*';
  /** @type {HTMLTextAreaElement} */ (document.getElementById('mockBody')).value = '';
  /** @type {HTMLInputElement} */ (document.getElementById('mockDelay')).value = '0';
  /** @type {HTMLInputElement} */ (document.getElementById('mockStatus')).value = '200';
  document.getElementById('mockResponseHeadersTable').innerHTML = '';
  document.getElementById('mockBodyNote').hidden = true;
  /** @type {HTMLInputElement} */ (document.getElementById('mockCors')).checked = false;
  capturedRequestHeaders = null;
  renderCapturedRequestHeaders();
}

export function initMock() {
  const panel = document.getElementById('mockPanel');
  // #329: every visit starts with the add-rule form closed.
  if (panel.dataset.initialized) { setMockFormOpen(false); loadRules(); return; }
  panel.dataset.initialized = '1';

  panel.innerHTML = `
    <div class="mock-toolbar">
      <span class="mock-sub" id="mockSubtitle">Replace responses for this session</span>
      <span class="mock-spacer"></span>
      <span class="mock-io-status" id="mockIoStatus"></span>
      <button class="net-chip mock-export-btn" id="mockExportBtn" type="button"><i class="icon-file-down" aria-hidden="true"></i>Export…</button>
      <button class="net-chip mock-import-btn" id="mockImportBtn" type="button"><i class="icon-file-up" aria-hidden="true"></i>Import…</button>
      <button class="tb-btn-primary" id="mockNewRuleBtn" type="button" aria-pressed="false"><i class="icon-plus" aria-hidden="true"></i>New rule</button>
    </div>
    <div class="mock-wrap">
      <form class="mock-form tb-form-card" id="mockForm" hidden>
        <div class="tb-form-title">New rule</div>
        <div class="mock-step-indicator" id="mockStepIndicator" aria-live="polite"></div>
        <div class="mock-step" data-step="1">
        <div class="mock-form-row mock-form-grid mock-request-grid">
          <label class="mock-field mock-field-method"><span class="mock-field-label">Method</span>
            <select class="mock-select" id="mockMethod" aria-label="HTTP method">
              <option value="*">Any method</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select></label>
          <label class="mock-field mock-field-url"><span class="mock-field-label">URL pattern</span>
            <input class="mock-input mock-url" id="mockUrl" type="text" placeholder="URL pattern (e.g. https://api.example.com/*)" spellcheck="false" required /></label>
        </div>
        </div>
        <div class="mock-step" data-step="2" hidden>
        <div class="mock-form-row mock-form-grid mock-response-grid">
          <label class="mock-field mock-field-status"><span class="mock-field-label">Status</span>
            <input class="mock-input mock-status" id="mockStatus" type="number" value="200" min="100" max="599" placeholder="Status" /></label>
          <label class="mock-field mock-field-delay"><span class="mock-field-label">Delay (ms)</span>
            <input class="mock-input mock-delay" id="mockDelay" type="number" value="0" min="0" max="120000" placeholder="Delay (ms)" aria-label="Delay in milliseconds before fulfilling this request, 0 to 120000" title="Delay before fulfilling this request, 0-120000ms" /></label>
        </div>
        <label class="mock-field"><span class="mock-field-label">Response body</span>
          <textarea class="mock-input mock-body" id="mockBody" rows="2" placeholder='Response body (e.g. {"error":"mocked"})'></textarea></label>
        <div class="mock-body-note" id="mockBodyNote" hidden>
          This call's body wasn't captured (binary content, or the response hadn't finished) — nothing to prefill here.
        </div>
        <div class="mock-headers-row">
          <div class="mock-headers-col">
            <div class="mock-headers-label">Response headers</div>
            <div class="kv-table" id="mockResponseHeadersTable"></div>
            <button type="button" class="kv-add-btn" id="mockAddResponseHeader">+ Add</button>
          </div>
          <div class="mock-headers-col" id="mockRequestHeadersCol" hidden>
            <div class="mock-headers-label" title="Provenance only — rules still match by URL pattern and method, never by headers">Request headers (from the captured call)</div>
            <div class="mock-request-headers" id="mockRequestHeadersList"></div>
          </div>
        </div>
        <label class="mock-cors-label">
          <input type="checkbox" id="mockCors" />
          Add CORS headers
        </label>
        <div class="mock-summary" id="mockSummary"></div>
        </div>
        <div class="mock-form-footer">
          <span class="mock-spacer"></span>
          <button class="mock-text-btn" id="mockCancelBtn" type="button">Cancel</button>
          <button class="mock-text-btn" id="mockBackBtn" type="button" hidden>Back</button>
          <button class="tb-btn-primary" id="mockNextBtn" type="button">Next</button>
          <button class="tb-btn-primary mock-add-btn" id="mockAddBtn" type="submit" hidden>Add rule</button>
        </div>
      </form>
      <div class="mock-table" id="mockTable">
        <div class="mock-head" id="mockHead" hidden>
          <span></span><span>Method</span><span>Pattern</span><span class="mock-num">Status</span><span class="mock-num">Hits</span><span>Last hit</span><span></span>
        </div>
        <div class="mock-rules" id="mockRules">
          <div class="mock-empty" id="mockEmpty"></div>
        </div>
      </div>
    </div>`;

  document.getElementById('mockEmpty').replaceChildren(renderEmptyState({
    icon: 'replace', tone: 'accent', title: 'Mock responses',
    text: 'Replace what a request returns without touching the server.',
    actionLabel: 'New rule', onAction: () => setMockFormOpen(true),
  }));
  document.getElementById('mockNewRuleBtn').addEventListener('click', () => setMockFormOpen(true));
  document.getElementById('mockBackBtn').addEventListener('click', () => showMockStep(mockStep - 1));
  document.getElementById('mockNextBtn').addEventListener('click', advanceMockStep);
  const mockFormEl = document.getElementById('mockForm');
  mockFormEl.addEventListener('input', updateMockStepState);
  mockFormEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); resetMockForm(); setMockFormOpen(false); }
    else if (e.key === 'Enter' && mockStep < MOCK_STEP_COUNT && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault(); advanceMockStep();
    }
  });
  document.getElementById('mockCancelBtn').addEventListener('click', () => {
    resetMockForm();
    setMockFormOpen(false);
  });

  document.getElementById('mockAddResponseHeader').addEventListener('click', () =>
    addKvRow(document.getElementById('mockResponseHeadersTable'), '', ''));

  // #264: export/import a JSON file of rules — id/hitCount/lastHitAt are
  // never round-tripped (export strips them; import always mints a fresh id
  // and starts hit stats at zero).
  document.getElementById('mockExportBtn').addEventListener('click', async () => {
    const sessionId = getActiveId();
    if (!sessionId) return;
    const statusEl = document.getElementById('mockIoStatus');
    const result = await testerBrowser.mock.exportRules(sessionId);
    if (result.canceled) { statusEl.textContent = ''; return; }
    statusEl.textContent = result.ok
      ? `Exported to ${result.path.split(/[\\/]/).pop()}`
      : (result.error || 'Export failed');
  });

  document.getElementById('mockImportBtn').addEventListener('click', async () => {
    const sessionId = getActiveId();
    if (!sessionId) return;
    const statusEl = document.getElementById('mockIoStatus');
    const result = await testerBrowser.mock.importRules(sessionId);
    if (result.canceled) { statusEl.textContent = ''; return; }
    if (!result.ok) { statusEl.textContent = result.error || 'Import failed'; return; }
    statusEl.textContent = result.skipped
      ? `Imported ${result.imported} rules (${result.skipped} skipped: ${result.firstSkipReason})`
      : `Imported ${result.imported} rules`;
    await loadRules();
  });

  document.getElementById('mockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!getActiveId()) return;
    if (mockStep < MOCK_STEP_COUNT) { advanceMockStep(); return; }
    const fv = mockFieldValues();
    if (!isMockStepValid(1, fv) || !isMockStepValid(2, fv)) return;
    /** @type {Omit<import('../src/main/mockManager').MockRule, 'hitCount' | 'lastHitAt'>} */
    const rule = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      urlPattern: /** @type {HTMLInputElement} */ (document.getElementById('mockUrl')).value.trim(),
      method: /** @type {HTMLSelectElement} */ (document.getElementById('mockMethod')).value,
      statusCode: parseInt(/** @type {HTMLInputElement} */ (document.getElementById('mockStatus')).value, 10) || 200,
      delayMs: parseInt(/** @type {HTMLInputElement} */ (document.getElementById('mockDelay')).value, 10) || 0,
      body: /** @type {HTMLTextAreaElement} */ (document.getElementById('mockBody')).value,
      responseHeaders: readKvTable(document.getElementById('mockResponseHeadersTable')),
      cors: /** @type {HTMLInputElement} */ (document.getElementById('mockCors')).checked,
      enabled: true,
    };
    if (capturedRequestHeaders) rule.requestHeaders = capturedRequestHeaders;
    await testerBrowser.mock.addRule(getActiveId(), rule);

    resetMockForm();
    setMockFormOpen(false);

    await loadRules();
  });

  loadRules();
  // Hit counts change as traffic flows without the user re-opening this tab;
  // keep them fresh while the Mock tab is the one being looked at.
  pollWhileVisible(() => {
    // Skip auto-refresh while a rule is being edited — the re-render would
    // replace the edit row with a read-only row, discarding in-progress edits.
    if (document.querySelector('#mockRules .mock-rule-row-editing')) return;
    return loadRules();
  }, 1500, () => getActiveConsoleTab() === 'mock');
}

async function loadRules() {
  const sessionId = getActiveId();
  if (!sessionId) return;
  const rules = await testerBrowser.mock.getRules(sessionId);
  renderRules(rules, sessionId);
}

// #235: sessionId is the tab loadRules() fetched these rules for — captured
// here and threaded through every row so a later toggle/remove/save acts on
// the tab the row was actually rendered for, not whatever tab happens to be
// active by the time the user clicks (getActiveId() may have moved on if
// they switched tabs while a row or its edit form was still open).
function renderRules(rules, sessionId) {
  const container = document.getElementById('mockRules');
  const empty = document.getElementById('mockEmpty');
  if (!container) return;

  const existingRows = container.querySelectorAll('.mock-rule-row');
  existingRows.forEach(r => r.remove());

  // "Replace responses for <active tab's name>" in the toolbar.
  const sub = document.getElementById('mockSubtitle');
  if (sub) {
    const name = document.querySelector('.tab.active .tab-name')?.textContent;
    sub.textContent = name ? `Replace responses for ${name}` : 'Replace responses for this session';
  }
  const head = document.getElementById('mockHead');
  if (head) head.hidden = rules.length === 0;

  if (rules.length === 0) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  rules.forEach((rule, index) => {
    container.appendChild(buildMockRuleRow(rule, sessionId, index, rules.length));
  });
}

// #263: rules are matched in this array's order (the first enabled match
// wins) — position/total drive the row's position number and disable the
// ↑/↓ button at either edge, making that order visible and controllable
// instead of only settable by delete-and-recreate.
function buildMockRuleRow(rule, sessionId, index, total) {
  const row = document.createElement('div');
  row.className = `mock-rule-row${rule.enabled ? '' : ' rule-row-disabled'}`;
  row.dataset.id = rule.id;
  row.innerHTML = `
    <label class="mock-toggle" title="Enable/disable">
      <input type="checkbox" class="mock-enable" aria-label="Enable rule ${index + 1}" ${rule.enabled ? 'checked' : ''} />
    </label>
    <span class="mock-rule-method">${escHtml(rule.method === '*' ? 'ANY' : rule.method)}</span>
    <div class="mock-rule-main">
      <span class="mock-rule-line"><span class="mock-rule-position" title="Match order">${index + 1}</span><span class="mock-rule-url" title="${escHtml(rule.urlPattern)}">${escHtml(rule.urlPattern)}</span>${rule.delayMs ? ` <span class="mock-badge mock-delay-badge" title="Fulfilled after a delay">${rule.delayMs}ms</span>` : ''}</span>
      <span class="mock-rule-body" title="${escHtml(rule.body)}">${escHtml(rule.body.slice(0, 80))}${rule.body.length > 80 ? '…' : ''}</span>
    </div>
    <span class="mock-status-badge">${rule.statusCode}</span>
    <span class="mock-hits-badge${rule.hitCount ? ' mock-hits-active' : ''}">${rule.hitCount || 0}</span>
    <span class="mock-lasthit" title="${rule.lastHitAt ? escHtml(new Date(rule.lastHitAt).toLocaleString()) : 'Not hit yet'}">${escHtml(formatAgo(rule.lastHitAt))}</span>
    <div class="mock-rule-actions">
      <button class="mock-icon-btn mock-move-up-btn" title="Move up (earlier match)" aria-label="Move rule up"${index === 0 ? ' disabled' : ''}><i class="icon-arrow-up" aria-hidden="true"></i></button>
      <button class="mock-icon-btn mock-move-down-btn" title="Move down (later match)" aria-label="Move rule down"${index === total - 1 ? ' disabled' : ''}><i class="icon-arrow-down" aria-hidden="true"></i></button>
      <button class="mock-icon-btn mock-edit-btn" title="Edit rule" aria-label="Edit rule"><i class="icon-pencil" aria-hidden="true"></i></button>
      <button class="mock-icon-btn mock-del-btn" title="Remove" aria-label="Remove rule"><i class="icon-trash-2" aria-hidden="true"></i></button>
    </div>`;

  row.querySelector('.mock-move-up-btn').addEventListener('click', async () => {
    await testerBrowser.mock.moveRule(sessionId, rule.id, 'up');
    await loadRules();
  });
  row.querySelector('.mock-move-down-btn').addEventListener('click', async () => {
    await testerBrowser.mock.moveRule(sessionId, rule.id, 'down');
    await loadRules();
  });
  row.querySelector('.mock-enable').addEventListener('change', async (e) => {
    await testerBrowser.mock.toggleRule(sessionId, rule.id, /** @type {HTMLInputElement} */ (e.target).checked);
    await loadRules();
  });
  row.querySelector('.mock-del-btn').addEventListener('click', async () => {
    await testerBrowser.mock.removeRule(sessionId, rule.id);
    await loadRules();
  });
  row.querySelector('.mock-edit-btn').addEventListener('click', () => {
    row.replaceWith(buildMockEditRow(rule, sessionId, index, total));
  });
  return row;
}

function showMockRowError(row, message) {
  let err = row.querySelector('.mock-row-error');
  if (!err) {
    err = document.createElement('div');
    err.className = 'mock-row-error';
    row.appendChild(err);
  }
  err.textContent = message;
  setTimeout(() => err.remove(), 6000);
}

function buildMockEditRow(rule, sessionId, index, total) {
  const row = document.createElement('div');
  row.className = 'mock-rule-row mock-rule-row-editing';
  row.dataset.id = rule.id;
  row.innerHTML = `
    <div class="mock-form-row">
      <input class="mock-input mock-edit-url" type="text" value="${escHtml(rule.urlPattern)}" spellcheck="false" />
      <select class="mock-select mock-edit-method">
        ${MOCK_METHODS.map(m => `<option value="${m}" ${m === rule.method ? 'selected' : ''}>${m === '*' ? 'Any method' : m}</option>`).join('')}
      </select>
      <input class="mock-input mock-status mock-edit-status" type="number" value="${rule.statusCode}" min="100" max="599" />
      <input class="mock-input mock-delay mock-edit-delay" type="number" value="${rule.delayMs || 0}" min="0" max="120000" placeholder="Delay (ms)" aria-label="Delay in milliseconds before fulfilling this request, 0 to 120000" title="Delay before fulfilling this request, 0-120000ms" />
    </div>
    <div class="mock-form-row">
      <textarea class="mock-input mock-body mock-edit-body" rows="2">${escHtml(rule.body)}</textarea>
    </div>
    <div class="mock-form-row mock-cors-row">
      <label class="mock-cors-label">
        <input type="checkbox" class="mock-edit-cors" ${rule.cors ? 'checked' : ''} />
        Add CORS headers
      </label>
    </div>
    <div class="mock-headers-row">
      <div class="mock-headers-col">
        <div class="mock-headers-label">Response headers</div>
        <div class="kv-table mock-edit-headers"></div>
        <button type="button" class="kv-add-btn mock-edit-add-header">+ Add</button>
      </div>
    </div>
    <div class="mock-form-row">
      <button class="mock-btn mock-save-btn" type="button">Save</button>
      <button class="mock-btn mock-cancel-btn" type="button">Cancel</button>
    </div>`;

  const headersTable = row.querySelector('.mock-edit-headers');
  for (const [k, v] of Object.entries(rule.responseHeaders || {})) addKvRow(headersTable, k, v);
  row.querySelector('.mock-edit-add-header').addEventListener('click', () => addKvRow(headersTable, '', ''));

  row.querySelector('.mock-cancel-btn').addEventListener('click', () => {
    row.replaceWith(buildMockRuleRow(rule, sessionId, index, total));
  });
  row.querySelector('.mock-save-btn').addEventListener('click', async () => {
    const patch = {
      urlPattern: /** @type {HTMLInputElement} */ (row.querySelector('.mock-edit-url')).value.trim(),
      method: /** @type {HTMLInputElement} */ (row.querySelector('.mock-edit-method')).value,
      statusCode: parseInt(/** @type {HTMLInputElement} */ (row.querySelector('.mock-edit-status')).value, 10) || 200,
      delayMs: parseInt(/** @type {HTMLInputElement} */ (row.querySelector('.mock-edit-delay')).value, 10) || 0,
      body: /** @type {HTMLInputElement} */ (row.querySelector('.mock-edit-body')).value,
      responseHeaders: readKvTable(headersTable),
      cors: /** @type {HTMLInputElement} */ (row.querySelector('.mock-edit-cors')).checked,
    };
    const ok = await testerBrowser.mock.updateRule(sessionId, rule.id, patch);
    if (!ok) { showMockRowError(row, 'That tab was closed — rule not saved'); return; }
    await loadRules();
  });
  return row;
}
