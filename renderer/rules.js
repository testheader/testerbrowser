/* global testerBrowser */
import { escHtml, MOCK_STRIPPED_RESPONSE_HEADERS, formatAgo } from './utils.js';
import { renderEmptyState } from './empty-state.js';
import { getActiveId } from './tabs.js';
import { getActiveConsoleTab, switchConsoleTab } from './console-tabs.js';
import { addKvRow, readKvTable } from './kv-table.js';
import { pollWhileVisible } from './poll.js';
import {
  ACTIONS, FAIL_MODES, RACE_MIN_COUNT, RACE_DEFAULT_GIVE_UP_SEC,
  stepCount, supportsDelay, isStepValid, isRuleValid, buildRule, ruleToFields, defaultFields,
  describeAction, summarizeRule,
} from './rules-logic.js';

// The Rules panel (#370): one ordered list per session — Mock, Fail, Delay,
// Hang, Race and Rewrite are all "match a request, then do something to it".
// Rules are matched top to bottom and the first one that applies wins, so the
// order is the priority; drag a row (or use ▲▼) to change it.

const METHODS = ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Request headers/body from the captured call the form is currently prefilled
// from — read-only provenance, never matched against. Reset on every prefill
// and after submit; null for a rule composed by hand.
let capturedRequestHeaders = null;
let capturedRequestBody = null;

// The rule being edited (null = adding a new one) and the form's current step.
let editingId = null;
let step = 1;
// A row being dragged — polling must not re-render the list under the drag.
let draggingId = null;
// Open sessions, for the cookie-source picker and for naming a rule's source.
/** @type {{ partition: string, name: string }[]} */
let knownSessions = [];

const el = (id) => document.getElementById(id);
const input = (id) => /** @type {HTMLInputElement} */ (el(id));
const select = (id) => /** @type {HTMLSelectElement} */ (el(id));
const area = (id) => /** @type {HTMLTextAreaElement} */ (el(id));

// ── Entry point from a captured request ─────────────────────────────────────

/**
 * "Rule" on a network request's detail panel or the replay overlay: opens the
 * form with the call's method and URL filled in. A call that has a response
 * becomes a Mock rule (status, headers and body prefilled); one that never got
 * a response starts as a failure.
 * @param {string} method
 * @param {string} url
 * @param {{ statusCode?: number, body?: string, responseHeaders?: Record<string,string>,
 *           requestHeaders?: Record<string,string>, requestBody?: string|null, bodyUnavailable?: boolean }} [opts]
 */
export function openRuleFromRequest(method, url, opts = {}) {
  switchConsoleTab('rules'); // also runs initRules() if this is the first visit
  if (!el('ruleUrl')) return;
  const fields = defaultFields();
  fields.urlPattern = url || '';
  fields.method = METHODS.includes(method) ? method : '*';
  if (opts.statusCode) {
    fields.kind = 'mock';
    fields.mockStatus = opts.statusCode;
    fields.mockBody = opts.body || '';
    // The captured call's own encoding headers describe the original, often
    // compressed, body — fulfilling with them attached corrupts the decoded one.
    fields.mockHeaders = Object.fromEntries(
      Object.entries(opts.responseHeaders || {}).filter(([k]) => !MOCK_STRIPPED_RESPONSE_HEADERS.includes(k.toLowerCase()))
    );
  } else {
    fields.kind = 'fail';
  }
  capturedRequestHeaders = opts.requestHeaders || null;
  capturedRequestBody = opts.requestBody ?? null;
  fields.rwBody = capturedRequestBody ?? '';
  openForm(fields, null, { bodyUnavailable: !!opts.bodyUnavailable });
  // Prefilled from a real call: land on the action step so one click picks what to do.
  showStep(2);
}

// ── Form ────────────────────────────────────────────────────────────────────

function currentKind() {
  return /** @type {import('./rules-logic.js').RuleKind} */ (input('ruleKind').value);
}

/** Reads the form's current values. */
function readFields() {
  return {
    method: select('ruleMethod').value,
    urlPattern: input('ruleUrl').value,
    probability: input('ruleProb').value,
    kind: currentKind(),
    failMode: select('ruleFailMode').value,
    delayMs: input('ruleDelay').value,
    hangFailAfterSec: input('ruleHangFailAfter').value,
    raceBatch: input('ruleRaceBatch').value,
    raceGiveUpSec: input('ruleRaceGiveUp').value,
    mockStatus: input('ruleMockStatus').value,
    mockBody: area('ruleMockBody').value,
    mockHeaders: readKvTable(el('ruleMockHeaders')),
    mockCors: input('ruleMockCors').checked,
    rwUrl: input('ruleRwUrl').value,
    rwMethod: select('ruleRwMethod').value,
    rwHeaders: readKvTable(el('ruleRwHeaders')),
    rwBodyOn: input('ruleRwBodyOn').checked,
    rwBody: area('ruleRwBody').value,
    cookiesOn: input('ruleCookiesOn').checked,
    cookieSource: select('ruleCookieSource').value,
    cookieExtra: readKvTable(el('ruleCookieExtra')),
  };
}

/** Writes values into the form. */
function writeFields(f) {
  select('ruleMethod').value = f.method;
  input('ruleUrl').value = f.urlPattern;
  input('ruleProb').value = String(f.probability);
  select('ruleFailMode').value = f.failMode;
  input('ruleDelay').value = String(f.delayMs);
  input('ruleHangFailAfter').value = String(f.hangFailAfterSec);
  input('ruleRaceBatch').value = String(f.raceBatch);
  input('ruleRaceGiveUp').value = String(f.raceGiveUpSec);
  input('ruleMockStatus').value = String(f.mockStatus);
  area('ruleMockBody').value = f.mockBody;
  fillKv(el('ruleMockHeaders'), f.mockHeaders);
  input('ruleMockCors').checked = f.mockCors;
  input('ruleRwUrl').value = f.rwUrl;
  select('ruleRwMethod').value = f.rwMethod;
  fillKv(el('ruleRwHeaders'), f.rwHeaders);
  input('ruleRwBodyOn').checked = f.rwBodyOn;
  area('ruleRwBody').value = f.rwBody;
  input('ruleCookiesOn').checked = f.cookiesOn;
  fillSourceOptions(f.cookieSource);
  fillKv(el('ruleCookieExtra'), f.cookieExtra);
  setKind(f.kind);
}

function fillKv(table, obj) {
  table.innerHTML = '';
  for (const [k, v] of Object.entries(obj || {})) addKvRow(table, k, v);
}

function renderCapturedRequestHeaders() {
  const col = el('ruleRequestHeadersCol');
  const list = el('ruleRequestHeadersList');
  if (!col || !list) return;
  const entries = Object.entries(capturedRequestHeaders || {});
  col.hidden = entries.length === 0;
  list.innerHTML = entries
    .map(([k, v]) => `<div class="rule-request-header-row"><span class="rule-request-header-key">${escHtml(k)}</span>: ${escHtml(String(v))}</div>`)
    .join('');
}

function openForm(fields, ruleId, { bodyUnavailable = false } = {}) {
  editingId = ruleId;
  writeFields(fields);
  el('ruleBodyNote').hidden = !bodyUnavailable;
  el('ruleFormTitle').textContent = ruleId ? 'Edit rule' : 'New rule';
  el('ruleAddBtn').textContent = ruleId ? 'Save rule' : 'Add rule';
  renderCapturedRequestHeaders();
  el('ruleForm').hidden = false;
  el('ruleNewBtn').setAttribute('aria-pressed', 'true');
  showStep(1);
  // The open sessions may have changed since the panel last loaded; keep the pick.
  refreshSessions().then(() => fillSourceOptions(select('ruleCookieSource').value));
}

function closeForm() {
  editingId = null;
  capturedRequestHeaders = null;
  capturedRequestBody = null;
  el('ruleForm').hidden = true;
  el('ruleNewBtn').setAttribute('aria-pressed', 'false');
}

/** Picks the action chip and shows only the settings that action has. */
function setKind(kind) {
  const action = ACTIONS.find((a) => a.kind === kind) || ACTIONS[0];
  input('ruleKind').value = action.kind;
  document.querySelectorAll('#ruleKindChips .rule-kind-chip').forEach((c) => {
    const on = /** @type {HTMLElement} */ (c).dataset.kind === action.kind;
    c.classList.toggle('active', on);
    c.setAttribute('aria-pressed', String(on));
  });
  el('ruleKindDesc').textContent = action.desc;
  el('ruleFailModeField').hidden = action.kind !== 'fail';
  el('ruleHangFields').hidden = action.kind !== 'hang';
  el('ruleRaceFields').hidden = action.kind !== 'race';
  el('ruleDelayField').hidden = !supportsDelay(action.kind);
  el('ruleDelayLabel').textContent = action.kind === 'delay' ? 'Delay (ms)' : 'Delay first (ms)';
  el('ruleMockDetails').hidden = action.kind !== 'mock';
  el('ruleRewriteDetails').hidden = action.kind !== 'rewrite';
  if (action.kind === 'delay' && !Number(input('ruleDelay').value)) input('ruleDelay').value = '2000';
  updateFormState();
}

function showStep(n) {
  const total = stepCount(currentKind());
  step = Math.min(total, Math.max(1, n));
  document.querySelectorAll('#ruleForm .rule-step').forEach((s) => {
    /** @type {HTMLElement} */ (s).hidden = Number(/** @type {HTMLElement} */ (s).dataset.step) !== step;
  });
  updateFormState();
  const focusId = step === 1 ? 'ruleUrl' : step === 2 ? null : (currentKind() === 'mock' ? 'ruleMockStatus' : 'ruleRwUrl');
  if (focusId) el(focusId).focus();
}

function updateFormState() {
  const f = readFields();
  const total = stepCount(f.kind);
  if (step > total) step = total;
  el('ruleStepIndicator').textContent = `Step ${step} of ${total}`;
  el('ruleBackBtn').hidden = step === 1;
  el('ruleNextBtn').hidden = step === total;
  el('ruleAddBtn').hidden = step !== total;
  /** @type {HTMLButtonElement} */ (el('ruleNextBtn')).disabled = !isStepValid(step, f);
  /** @type {HTMLButtonElement} */ (el('ruleAddBtn')).disabled = !isRuleValid(f);
  el('ruleSummary').textContent = summarizeRule(f);
  // The rewrite's body/cookie fields only matter once their checkbox is on.
  area('ruleRwBody').disabled = !f.rwBodyOn;
  el('ruleCookieFields').hidden = !f.cookiesOn;
}

function advance() {
  if (step < stepCount(currentKind()) && isStepValid(step, readFields())) showStep(step + 1);
}

/** Fills the cookie-source picker with the open sessions (and a closed source, if the rule has one). */
function fillSourceOptions(selected) {
  const sel = select('ruleCookieSource');
  const options = [{ value: '', label: 'No source session (extra cookies only)' }]
    .concat(knownSessions.map((s) => ({ value: s.partition, label: s.name })));
  if (selected && !knownSessions.some((s) => s.partition === selected)) {
    options.push({ value: selected, label: '(closed session) — using its last cookies' });
  }
  sel.innerHTML = options.map((o) => `<option value="${escHtml(o.value)}">${escHtml(o.label)}</option>`).join('');
  sel.value = selected || '';
}

async function refreshSessions() {
  try {
    const list = await testerBrowser.sessions.list();
    knownSessions = (list || []).map((s) => ({ partition: s.partition, name: s.name }));
  } catch { /* keep the last known list */ }
}

function sourceName(partition) {
  return knownSessions.find((s) => s.partition === partition)?.name;
}

// ── Panel ───────────────────────────────────────────────────────────────────

export function initRules() {
  const panel = el('rulesPanel');
  // Every visit starts with the form closed.
  if (panel.dataset.initialized) { closeForm(); loadRules(); return; }
  panel.dataset.initialized = '1';

  const methodOptions = METHODS.map((m) => `<option value="${m}">${m === '*' ? 'Any method' : m}</option>`).join('');
  const kindChips = ACTIONS.map((a) =>
    `<button type="button" class="rule-kind-chip" data-kind="${a.kind}" aria-pressed="false"><i class="icon-${a.icon}" aria-hidden="true"></i>${a.label}</button>`).join('');
  const failOptions = FAIL_MODES.map((m) => `<option value="${m.value}">${escHtml(m.label)}</option>`).join('');

  panel.innerHTML = `
    <div class="rule-toolbar">
      <span class="rule-sub" id="ruleSubtitle">Change requests and responses for this session</span>
      <span class="rule-spacer"></span>
      <span class="rule-io-status" id="ruleIoStatus"></span>
      <button class="net-chip rule-export-btn" id="ruleExportBtn" type="button"><i class="icon-file-down" aria-hidden="true"></i>Export…</button>
      <button class="net-chip rule-import-btn" id="ruleImportBtn" type="button"><i class="icon-file-up" aria-hidden="true"></i>Import…</button>
      <button class="tb-btn-primary" id="ruleNewBtn" type="button" aria-pressed="false"><i class="icon-plus" aria-hidden="true"></i>New rule</button>
    </div>
    <div class="rule-wrap">
      <form class="rule-form tb-form-card" id="ruleForm" hidden>
        <div class="tb-form-title" id="ruleFormTitle">New rule</div>
        <div class="rule-step-indicator" id="ruleStepIndicator" aria-live="polite"></div>

        <div class="rule-step" data-step="1">
          <div class="rule-form-grid rule-match-grid">
            <label class="rule-field"><span class="rule-field-label">Method</span>
              <select class="rule-select" id="ruleMethod" aria-label="HTTP method">${methodOptions}</select></label>
            <label class="rule-field rule-field-url"><span class="rule-field-label">URL pattern</span>
              <input class="rule-input rule-url-input" id="ruleUrl" type="text" placeholder="URL pattern (e.g. https://api.example.com/*)" spellcheck="false" required /></label>
            <label class="rule-field"><span class="rule-field-label">Applies to (%)</span>
              <input class="rule-input" id="ruleProb" type="number" value="100" min="1" max="100" aria-label="Share of matching requests this rule applies to, 1 to 100 percent" title="Share of matching requests this rule applies to. Under 100, the rest fall through to the next rule." /></label>
          </div>
        </div>

        <div class="rule-step" data-step="2" hidden>
          <input type="hidden" id="ruleKind" value="mock" />
          <div class="rule-kind-chips" id="ruleKindChips" role="group" aria-label="What to do with matching requests">${kindChips}</div>
          <div class="rule-kind-desc" id="ruleKindDesc"></div>
          <div class="rule-form-grid rule-action-grid">
            <label class="rule-field" id="ruleFailModeField"><span class="rule-field-label">Fail with</span>
              <select class="rule-select" id="ruleFailMode">${failOptions}</select></label>
            <label class="rule-field" id="ruleDelayField"><span class="rule-field-label" id="ruleDelayLabel">Delay first (ms)</span>
              <input class="rule-input" id="ruleDelay" type="number" value="0" min="0" max="120000" aria-label="Delay in milliseconds before the rule is applied, 0 to 120000" title="Wait this long before applying the rule, 0-120000 ms" /></label>
            <div class="rule-fields-pair" id="ruleHangFields">
              <label class="rule-field"><span class="rule-field-label">Fail after (s)</span>
                <input class="rule-input" id="ruleHangFailAfter" type="number" value="0" min="0" max="600" aria-label="Seconds before a hung request is failed, 0 to never" title="Fail the request with a timeout after this long. 0 leaves it pending until the page gives up." /></label>
            </div>
            <div class="rule-fields-pair" id="ruleRaceFields">
              <label class="rule-field"><span class="rule-field-label">Send together</span>
                <input class="rule-input" id="ruleRaceBatch" type="number" value="${RACE_MIN_COUNT}" min="${RACE_MIN_COUNT}" max="50" aria-label="Number of requests to hold, then send together" title="Hold matching requests until this many have arrived (from any tab on this session), then send them all at once." /></label>
              <label class="rule-field"><span class="rule-field-label">Give up after (s)</span>
                <input class="rule-input" id="ruleRaceGiveUp" type="number" value="${RACE_DEFAULT_GIVE_UP_SEC}" min="1" max="120" aria-label="Seconds to wait for the batch to fill" title="If the batch never fills, send what has arrived after this long, so the page is never stuck." /></label>
            </div>
          </div>
        </div>

        <div class="rule-step" data-step="3" hidden>
          <div id="ruleMockDetails" hidden>
            <label class="rule-field rule-field-status"><span class="rule-field-label">Status</span>
              <input class="rule-input rule-status-input" id="ruleMockStatus" type="number" value="200" min="100" max="599" /></label>
            <label class="rule-field"><span class="rule-field-label">Response body</span>
              <textarea class="rule-input rule-body-input" id="ruleMockBody" rows="3" placeholder='Response body (e.g. {"error":"mocked"})'></textarea></label>
            <div class="rule-body-note" id="ruleBodyNote" hidden>This call's body wasn't captured (binary content, or the response hadn't finished) — nothing to prefill here.</div>
            <div class="rule-headers-col">
              <div class="rule-headers-label">Response headers</div>
              <div class="kv-table" id="ruleMockHeaders"></div>
              <button type="button" class="kv-add-btn" id="ruleMockAddHeader">+ Add</button>
            </div>
            <label class="rule-cors-label"><input type="checkbox" id="ruleMockCors" /> Add CORS headers</label>
          </div>

          <div id="ruleRewriteDetails" hidden>
            <div class="rule-form-grid rule-rewrite-grid">
              <label class="rule-field rule-field-url"><span class="rule-field-label">Send to URL (optional)</span>
                <input class="rule-input rule-url-input" id="ruleRwUrl" type="text" placeholder="Leave empty to keep the original URL" spellcheck="false" /></label>
              <label class="rule-field"><span class="rule-field-label">Method</span>
                <select class="rule-select" id="ruleRwMethod" aria-label="Method to send instead">${METHODS.map((m) => `<option value="${m}">${m === '*' ? 'Keep original' : m}</option>`).join('')}</select></label>
            </div>
            <div class="rule-headers-col">
              <div class="rule-headers-label" title="Set on top of the original headers. An empty value removes a header the page set. Headers the browser adds itself (such as Accept-Language) can be changed but not removed.">Headers to set (empty value removes)</div>
              <div class="kv-table" id="ruleRwHeaders"></div>
              <button type="button" class="kv-add-btn" id="ruleRwAddHeader">+ Add</button>
            </div>
            <label class="rule-cors-label"><input type="checkbox" id="ruleRwBodyOn" /> Replace the request body</label>
            <textarea class="rule-input rule-body-input" id="ruleRwBody" rows="3" placeholder="Body to send instead" disabled></textarea>
            <label class="rule-cors-label"><input type="checkbox" id="ruleCookiesOn" /> Send these cookies instead of this tab's own</label>
            <div id="ruleCookieFields" hidden>
              <label class="rule-field"><span class="rule-field-label" title="Read live at every request. If that session is closed, its last cookies are used.">Take the cookies of</span>
                <select class="rule-select" id="ruleCookieSource"></select></label>
              <div class="rule-headers-col">
                <div class="rule-headers-label" title="Added on top of the session's cookies. An extra cookie replaces one with the same name.">Extra cookies</div>
                <div class="kv-table" id="ruleCookieExtra"></div>
                <button type="button" class="kv-add-btn" id="ruleCookieAddExtra">+ Add</button>
              </div>
            </div>
          </div>

          <div class="rule-headers-col" id="ruleRequestHeadersCol" hidden>
            <div class="rule-headers-label" title="Provenance only — rules match by URL pattern and method, never by headers">Request headers (from the captured call)</div>
            <div class="rule-request-headers" id="ruleRequestHeadersList"></div>
          </div>
        </div>

        <div class="rule-summary" id="ruleSummary"></div>
        <div class="rule-form-footer">
          <span class="rule-spacer"></span>
          <button class="rule-text-btn" id="ruleCancelBtn" type="button">Cancel</button>
          <button class="rule-text-btn" id="ruleBackBtn" type="button" hidden>Back</button>
          <button class="tb-btn-primary" id="ruleNextBtn" type="button">Next</button>
          <button class="tb-btn-primary rule-add-btn" id="ruleAddBtn" type="submit" hidden>Add rule</button>
        </div>
      </form>

      <div class="rule-table" id="ruleTable">
        <div class="rule-head" id="ruleHead" hidden>
          <span></span><span></span><span>Method</span><span>Pattern and action</span><span class="rule-num">Applies</span><span class="rule-num">Hits</span><span>Last hit</span><span></span>
        </div>
        <div class="rule-rows" id="ruleRows">
          <div class="rule-empty" id="ruleEmpty"></div>
        </div>
      </div>
    </div>`;

  el('ruleEmpty').replaceChildren(renderEmptyState({
    icon: 'replace', tone: 'accent', title: 'Rules',
    text: 'Mock, fail, delay or rewrite the requests this session makes.',
    actionLabel: 'New rule', onAction: () => openForm(defaultFields(), null),
  }));

  el('ruleNewBtn').addEventListener('click', () => { capturedRequestHeaders = null; capturedRequestBody = null; openForm(defaultFields(), null); });
  el('ruleBackBtn').addEventListener('click', () => showStep(step - 1));
  el('ruleNextBtn').addEventListener('click', advance);
  el('ruleCancelBtn').addEventListener('click', closeForm);
  el('ruleKindChips').addEventListener('click', (e) => {
    const chip = /** @type {HTMLElement} */ (e.target).closest('.rule-kind-chip');
    if (chip) setKind(/** @type {HTMLElement} */ (chip).dataset.kind);
  });
  const form = el('ruleForm');
  form.addEventListener('input', updateFormState);
  form.addEventListener('change', updateFormState);
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeForm(); }
    else if (e.key === 'Enter' && step < stepCount(currentKind()) && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault(); advance();
    }
  });
  // The kv editors add and remove rows without an input event.
  form.addEventListener('click', () => setTimeout(updateFormState, 0));
  el('ruleMockAddHeader').addEventListener('click', () => addKvRow(el('ruleMockHeaders'), '', ''));
  el('ruleRwAddHeader').addEventListener('click', () => addKvRow(el('ruleRwHeaders'), '', ''));
  el('ruleCookieAddExtra').addEventListener('click', () => addKvRow(el('ruleCookieExtra'), '', ''));

  // Export/import a JSON file of rules — id/hit stats/cookie source are never
  // round-tripped (export strips them; import mints fresh ids).
  el('ruleExportBtn').addEventListener('click', async () => {
    const sessionId = getActiveId();
    if (!sessionId) return;
    const statusEl = el('ruleIoStatus');
    const result = await testerBrowser.rules.exportRules(sessionId);
    if (result.canceled) { statusEl.textContent = ''; return; }
    statusEl.textContent = result.ok ? `Exported to ${result.path.split(/[\\/]/).pop()}` : (result.error || 'Export failed');
  });
  el('ruleImportBtn').addEventListener('click', async () => {
    const sessionId = getActiveId();
    if (!sessionId) return;
    const statusEl = el('ruleIoStatus');
    const result = await testerBrowser.rules.importRules(sessionId);
    if (result.canceled) { statusEl.textContent = ''; return; }
    if (!result.ok) { statusEl.textContent = result.error || 'Import failed'; return; }
    statusEl.textContent = result.skipped
      ? `Imported ${result.imported} rules (${result.skipped} skipped: ${result.firstSkipReason})`
      : `Imported ${result.imported} rules`;
    await loadRules();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sessionId = getActiveId();
    if (!sessionId) return;
    if (step < stepCount(currentKind())) { advance(); return; }
    const f = readFields();
    if (!isRuleValid(f)) return;
    const built = buildRule(f);
    if (capturedRequestHeaders) built.requestHeaders = capturedRequestHeaders;
    if (capturedRequestBody !== null && capturedRequestBody !== undefined) built.requestBody = capturedRequestBody;
    if (editingId) {
      const ok = await testerBrowser.rules.updateRule(sessionId, editingId, built);
      if (!ok) { showFormError('That tab was closed — rule not saved'); return; }
    } else {
      await testerBrowser.rules.addRule(sessionId, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, enabled: true, ...built });
    }
    closeForm();
    await loadRules();
  });

  loadRules();
  // Hit counts change as traffic flows without the user re-opening this tab;
  // keep them fresh while Rules is the tab being looked at (but never under a drag).
  pollWhileVisible(() => (draggingId ? undefined : loadRules()), 1500, () => getActiveConsoleTab() === 'rules');
}

function showFormError(message) {
  let err = document.querySelector('#ruleForm .rule-row-error');
  if (!err) {
    err = document.createElement('div');
    err.className = 'rule-row-error';
    el('ruleForm').insertBefore(err, el('ruleSummary'));
  }
  err.textContent = message;
  setTimeout(() => err.remove(), 6000);
}

// ── Rules table ─────────────────────────────────────────────────────────────

export async function loadRules() {
  const sessionId = getActiveId();
  if (!sessionId || !el('ruleRows')) return;
  await refreshSessions();
  const rules = await testerBrowser.rules.getRules(sessionId);
  renderRules(rules, sessionId);
}

// sessionId is the tab loadRules() fetched these rules for — threaded through
// every row so a later toggle/remove acts on the tab the row was rendered for,
// not whatever tab happens to be active by the time the user clicks.
function renderRules(rules, sessionId) {
  const container = el('ruleRows');
  container.querySelectorAll('.rule-row').forEach((r) => r.remove());

  const sub = el('ruleSubtitle');
  const name = document.querySelector('.tab.active .tab-name')?.textContent;
  sub.textContent = name ? `Change requests and responses for ${name}` : 'Change requests and responses for this session';
  el('ruleHead').hidden = rules.length === 0;
  el('ruleEmpty').hidden = rules.length > 0;

  rules.forEach((rule, index) => container.appendChild(buildRuleRow(rule, sessionId, index, rules.length)));
}

function buildRuleRow(rule, sessionId, index, total) {
  const row = document.createElement('div');
  row.className = `rule-row${rule.enabled ? '' : ' rule-row-disabled'}`;
  row.dataset.id = rule.id;
  row.dataset.index = String(index);
  const a = rule.action || {};
  const closedSource = a.kind === 'rewrite' && a.cookies?.sourcePartition && !sourceName(a.cookies.sourcePartition);
  const body = a.kind === 'mock' ? a.body || '' : '';
  const pct = Math.round((rule.probability ?? 1) * 100);
  row.innerHTML = `
    <span class="rule-drag" title="Drag to change the order" aria-hidden="true"><i class="icon-grip-vertical"></i></span>
    <label class="rule-toggle" title="Enable/disable">
      <input type="checkbox" class="rule-enable" aria-label="Enable rule ${index + 1}" ${rule.enabled ? 'checked' : ''} />
    </label>
    <span class="rule-method">${escHtml(rule.method === '*' ? 'ANY' : rule.method)}</span>
    <div class="rule-main">
      <span class="rule-line"><span class="rule-position" title="Match order — the first rule that applies wins">${index + 1}</span><span class="rule-url" title="${escHtml(rule.urlPattern)}">${escHtml(rule.urlPattern)}</span></span>
      <span class="rule-action-line">
        <span class="rule-badge rule-kind-${escHtml(a.kind || 'unknown')}">${escHtml(describeAction(rule, sourceName))}</span>
        ${closedSource ? `<span class="rule-badge rule-closed-badge" title="That session is closed. The rule keeps using its last cookies.">source closed${a.cookies.snapshotCount ? `, ${a.cookies.snapshotCount} cookies kept` : ''}</span>` : ''}
        ${body ? `<span class="rule-body" title="${escHtml(body)}">${escHtml(body.slice(0, 80))}${body.length > 80 ? '…' : ''}</span>` : ''}
      </span>
    </div>
    <span class="rule-num rule-prob">${pct}%</span>
    <span class="rule-hits-badge${rule.hitCount ? ' rule-hits-active' : ''}">${rule.hitCount || 0}</span>
    <span class="rule-lasthit" title="${rule.lastHitAt ? escHtml(new Date(rule.lastHitAt).toLocaleString()) : 'Not hit yet'}">${escHtml(formatAgo(rule.lastHitAt))}</span>
    <div class="rule-actions">
      <button class="rule-icon-btn rule-move-up-btn" title="Move up (matched earlier)" aria-label="Move rule up"${index === 0 ? ' disabled' : ''}><i class="icon-arrow-up" aria-hidden="true"></i></button>
      <button class="rule-icon-btn rule-move-down-btn" title="Move down (matched later)" aria-label="Move rule down"${index === total - 1 ? ' disabled' : ''}><i class="icon-arrow-down" aria-hidden="true"></i></button>
      <button class="rule-icon-btn rule-edit-btn" title="Edit rule" aria-label="Edit rule"><i class="icon-pencil" aria-hidden="true"></i></button>
      <button class="rule-icon-btn rule-del-btn" title="Remove" aria-label="Remove rule"><i class="icon-trash-2" aria-hidden="true"></i></button>
    </div>`;

  const reload = () => loadRules();
  row.querySelector('.rule-move-up-btn').addEventListener('click', async () => { await testerBrowser.rules.moveRule(sessionId, rule.id, 'up'); await reload(); });
  row.querySelector('.rule-move-down-btn').addEventListener('click', async () => { await testerBrowser.rules.moveRule(sessionId, rule.id, 'down'); await reload(); });
  row.querySelector('.rule-enable').addEventListener('change', async (e) => {
    await testerBrowser.rules.toggleRule(sessionId, rule.id, /** @type {HTMLInputElement} */ (e.target).checked);
    await reload();
  });
  row.querySelector('.rule-del-btn').addEventListener('click', async () => { await testerBrowser.rules.removeRule(sessionId, rule.id); await reload(); });
  row.querySelector('.rule-edit-btn').addEventListener('click', () => {
    capturedRequestHeaders = rule.requestHeaders || null;
    capturedRequestBody = rule.requestBody ?? null;
    openForm(ruleToFields(rule), rule.id);
  });

  // Drag and drop: the handle arms the row, dropping onto another row puts the
  // dragged rule at that row's position.
  const handle = row.querySelector('.rule-drag');
  handle.addEventListener('mousedown', () => { row.draggable = true; });
  row.addEventListener('mouseup', () => { if (!draggingId) row.draggable = false; });
  row.addEventListener('dragstart', (e) => {
    draggingId = rule.id;
    row.classList.add('rule-row-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', rule.id); }
  });
  row.addEventListener('dragend', () => {
    draggingId = null;
    row.draggable = false;
    row.classList.remove('rule-row-dragging');
    document.querySelectorAll('.rule-row-drop').forEach((r) => r.classList.remove('rule-row-drop'));
  });
  row.addEventListener('dragover', (e) => {
    if (!draggingId || draggingId === rule.id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.rule-row-drop').forEach((r) => r.classList.remove('rule-row-drop'));
    row.classList.add('rule-row-drop');
  });
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    const movedId = draggingId;
    draggingId = null;
    if (!movedId || movedId === rule.id) return;
    await testerBrowser.rules.reorderRule(sessionId, movedId, index);
    await reload();
  });
  return row;
}
