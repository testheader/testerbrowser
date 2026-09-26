/* global testerBrowser */
import { escHtml, MOCK_STRIPPED_RESPONSE_HEADERS } from './utils.js';
import { getActiveId } from './tabs.js';
import { getActiveConsoleTab, switchConsoleTab } from './console-tabs.js';
import { addKvRow, readKvTable } from './kv-table.js';

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
  const urlInput    = document.getElementById('mockUrl');
  const methodSel   = document.getElementById('mockMethod');
  const statusInput = document.getElementById('mockStatus');
  const bodyInput   = document.getElementById('mockBody');
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

  urlInput.focus();
}

export function initMock() {
  const panel = document.getElementById('mockPanel');
  if (panel.dataset.initialized) { loadRules(); return; }
  panel.dataset.initialized = '1';

  panel.innerHTML = `
    <div class="mock-wrap">
      <form class="mock-form" id="mockForm">
        <div class="mock-form-row">
          <input class="mock-input mock-url" id="mockUrl" type="text" placeholder="URL pattern (e.g. https://api.example.com/*)" spellcheck="false" required />
          <select class="mock-select" id="mockMethod">
            <option value="*">Any method</option>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
          </select>
          <input class="mock-input mock-status" id="mockStatus" type="number" value="200" min="100" max="599" placeholder="Status" />
        </div>
        <div class="mock-form-row">
          <textarea class="mock-input mock-body" id="mockBody" rows="2" placeholder='Response body (e.g. {"error":"mocked"})'></textarea>
        </div>
        <div class="mock-body-note" id="mockBodyNote" hidden>
          This call's body wasn't captured (binary content, or the response hadn't finished) — nothing to prefill here.
        </div>
        <div class="mock-form-row mock-cors-row">
          <label class="mock-cors-label">
            <input type="checkbox" id="mockCors" />
            Add CORS headers
          </label>
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
        <button class="mock-btn mock-add-btn" type="submit">Add rule</button>
      </form>
      <div class="mock-rules" id="mockRules">
        <div class="mock-empty" id="mockEmpty">Add a rule above to intercept requests.</div>
      </div>
    </div>`;

  document.getElementById('mockAddResponseHeader').addEventListener('click', () =>
    addKvRow(document.getElementById('mockResponseHeadersTable'), '', ''));

  document.getElementById('mockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!getActiveId()) return;
    const rule = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      urlPattern: document.getElementById('mockUrl').value.trim(),
      method: document.getElementById('mockMethod').value,
      statusCode: parseInt(document.getElementById('mockStatus').value, 10) || 200,
      body: document.getElementById('mockBody').value,
      responseHeaders: readKvTable(document.getElementById('mockResponseHeadersTable')),
      cors: document.getElementById('mockCors').checked,
      enabled: true,
    };
    if (capturedRequestHeaders) rule.requestHeaders = capturedRequestHeaders;
    await testerBrowser.mock.addRule(getActiveId(), rule);

    document.getElementById('mockUrl').value  = '';
    document.getElementById('mockBody').value = '';
    document.getElementById('mockResponseHeadersTable').innerHTML = '';
    document.getElementById('mockBodyNote').hidden = true;
    document.getElementById('mockCors').checked = false;
    capturedRequestHeaders = null;
    renderCapturedRequestHeaders();

    await loadRules();
  });

  loadRules();
  // Hit counts change as traffic flows without the user re-opening this tab;
  // keep them fresh while the Mock tab is the one being looked at.
  // Skip auto-refresh while a rule is being edited — the re-render would
  // replace the edit row with a read-only row, discarding in-progress edits.
  setInterval(() => {
    if (getActiveConsoleTab() !== 'mock') return;
    if (document.querySelector('#mockRules .mock-rule-row-editing')) return;
    loadRules();
  }, 1500);
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

  if (rules.length === 0) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  for (const rule of rules) {
    container.appendChild(buildMockRuleRow(rule, sessionId));
  }
}

function buildMockRuleRow(rule, sessionId) {
  const row = document.createElement('div');
  row.className = `mock-rule-row${rule.enabled ? '' : ' rule-row-disabled'}`;
  row.dataset.id = rule.id;
  row.innerHTML = `
    <label class="mock-toggle" title="Enable/disable">
      <input type="checkbox" class="mock-enable" ${rule.enabled ? 'checked' : ''} />
      <span class="mock-toggle-label"></span>
    </label>
    <span class="mock-rule-method mock-badge">${escHtml(rule.method)}</span>
    <span class="mock-rule-url" title="${escHtml(rule.urlPattern)}">${escHtml(rule.urlPattern)}</span>
    <span class="mock-badge mock-status-badge">${rule.statusCode}</span>
    <span class="mock-rule-body" title="${escHtml(rule.body)}">${escHtml(rule.body.slice(0, 40))}${rule.body.length > 40 ? '…' : ''}</span>
    ${rule.enabled ? '' : '<span class="rule-inactive-badge" title="Kept, but not currently applied to any request">Inactive</span>'}
    <span class="mock-badge mock-hits-badge${rule.hitCount ? ' mock-hits-active' : ''}" title="${rule.lastHitAt ? 'Last hit ' + new Date(rule.lastHitAt).toLocaleTimeString() : 'Not hit yet'}">Hits: ${rule.hitCount || 0}</span>
    <button class="mock-btn mock-edit-btn" title="Edit rule">✎</button>
    <button class="mock-btn mock-del-btn" title="Remove">✕</button>`;

  row.querySelector('.mock-enable').addEventListener('change', async (e) => {
    await testerBrowser.mock.toggleRule(sessionId, rule.id, e.target.checked);
    await loadRules();
  });
  row.querySelector('.mock-del-btn').addEventListener('click', async () => {
    await testerBrowser.mock.removeRule(sessionId, rule.id);
    await loadRules();
  });
  row.querySelector('.mock-edit-btn').addEventListener('click', () => {
    row.replaceWith(buildMockEditRow(rule, sessionId));
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

function buildMockEditRow(rule, sessionId) {
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
    row.replaceWith(buildMockRuleRow(rule, sessionId));
  });
  row.querySelector('.mock-save-btn').addEventListener('click', async () => {
    const patch = {
      urlPattern: row.querySelector('.mock-edit-url').value.trim(),
      method: row.querySelector('.mock-edit-method').value,
      statusCode: parseInt(row.querySelector('.mock-edit-status').value, 10) || 200,
      body: row.querySelector('.mock-edit-body').value,
      responseHeaders: readKvTable(headersTable),
      cors: row.querySelector('.mock-edit-cors').checked,
    };
    const ok = await testerBrowser.mock.updateRule(sessionId, rule.id, patch);
    if (!ok) { showMockRowError(row, 'That tab was closed — rule not saved'); return; }
    await loadRules();
  });
  return row;
}
