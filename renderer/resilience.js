/* global testerBrowser */
import { escHtml, formatAgo } from './utils.js';
import { getActiveId, refreshTabs } from './tabs.js';

import { getActiveConsoleTab, switchConsoleTab } from './console-tabs.js';
import { pollWhileVisible } from './poll.js';
import { renderEmptyState } from './empty-state.js';
import { RES_STEP_COUNT, isResStepValid, summarizeResRule } from './resilience-logic.js';

/** @typedef {import('../src/main/resilienceManager').ResilienceType} ResilienceType */

// Request headers/body from the captured call the add-rule form is currently
// prefilled from — read-only provenance, shown in a rule's edit view once
// saved. Never sent to the real server or matched against; only method +
// urlPattern decide whether a rule fires. Reset on every prefill and after
// submit; stay null for a rule composed by hand.
let capturedMethod         = null;
let capturedRequestHeaders = null;
let capturedRequestBody    = null;

// Entry point for the "⇒ Resilience" button on a network request's detail
// panel: switches to the Resilience tab and prefills the add-rule form's URL
// with this exact call's URL (not a glob — the tester can widen it), scopes
// the rule to the call's method, and defaults type/probability to the most
// common case (500 error, 100%) so a single click plus Add is enough.
export function openResilienceFromRequest(method, url, requestHeaders, requestBody) {
  switchConsoleTab('resilience'); // also runs initResilience() if this is the first visit
  const urlInput = /** @type {HTMLInputElement} */ (document.getElementById('resUrl'));
  if (!urlInput) return;
  urlInput.value = url || '*';

  setResType('error500');
  /** @type {HTMLInputElement} */ (document.getElementById('resProb')).value = '100';
  capturedMethod         = method || null;
  capturedRequestHeaders = requestHeaders || null;
  capturedRequestBody    = requestBody ?? null;
  updateMethodChip();
  setResFormOpen(true, RES_STEP_COUNT); // prefilled: land on the summary step
}

// #236: the "⇒ Resilience" prefill scopes the rule to the captured call's
// method — shown here so that scoping is visible, and removable ("clear")
// rather than a silent, easy-to-miss constraint. Editing the URL field by
// hand also clears it (see the resUrl input listener below): the method was
// only ever meant to travel with the *exact* captured URL, and once the
// tester starts changing that, keeping it scoped is more likely to
// surprise than help.
function updateMethodChip() {
  const chip  = document.getElementById('resMethodChip');
  const label = document.getElementById('resMethodChipLabel');
  if (!chip || !label) return;
  if (capturedMethod) {
    label.textContent = capturedMethod;
    chip.classList.remove('res-hidden');
  } else {
    chip.classList.add('res-hidden');
  }
}

const TYPES = [
  { value: 'error500',  label: '500 error',       icon: 'server-crash',  desc: 'Returns HTTP 500 Internal Server Error.' },
  { value: 'timeout',   label: 'Gateway timeout', icon: 'hourglass',     desc: 'Returns HTTP 504 Gateway Timeout immediately.' },
  { value: 'stall504',  label: 'Stall then 504',  icon: 'timer-reset',   desc: 'Waits for the delay, then returns HTTP 504 Gateway Timeout.' },
  { value: 'hang',      label: 'Hang',            icon: 'pause',         desc: 'Never responds — the request stays pending until the page aborts it or navigates away.' },
  { value: 'offline',   label: 'Offline',         icon: 'wifi-off',      desc: 'Fails the request as if the network were disconnected.' },
  { value: 'missing',   label: '404',             icon: 'file-x',        desc: 'Returns HTTP 404 Not Found.' },
  { value: 'corrupt',   label: 'Corrupt body',    icon: 'file-warning',  desc: 'Returns 200 with a garbled binary body.' },
  { value: 'latency',   label: 'Latency',         icon: 'timer',         desc: 'Delays the request by the given milliseconds, then lets it through.' },
  { value: 'random500', label: 'Random 500',      icon: 'dices',         desc: 'Returns HTTP 500 on a random share of requests — set the probability.' },
];

// #311: the failure type is picked from a row of chips; #resType (a hidden
// input) carries the current value so the rest of the form reads it as before.
function setResType(type) {
  const t = TYPES.find(x => x.value === type) || TYPES[0];
  const input = /** @type {HTMLInputElement} */ (document.getElementById('resType'));
  if (!input) return;
  input.value = t.value;
  document.querySelectorAll('#resTypeChips .res-type-chip').forEach(c => {
    const on = /** @type {HTMLElement} */ (c).dataset.type === t.value;
    c.classList.toggle('active', on);
    c.setAttribute('aria-pressed', String(on));
  });
  document.getElementById('resTypeDesc').textContent = t.desc;
  applyTypeFieldVisibility(t.value, document.getElementById('resLatencyField'),
    /** @type {HTMLInputElement} */ (document.getElementById('resLatency')), document.getElementById('resLatencyLabel'),
    document.getElementById('resReleaseField'));
}

// The add-rule form is inline and closed by default — Add rule opens it, as
// does "Resilience" on a captured request; Cancel / Add rule close it again.
function setResFormOpen(open, step = 1) {
  const form = document.getElementById('resForm');
  if (form) form.hidden = !open;
  if (open) showResStep(step);
}

// #353: the add-rule form is a 3-step stepper inside the card — failure type,
// URL pattern, options (+ summary and the Add rule button). Step state is
// renderer-only; every field keeps its id and the rule payload is unchanged.
let resStep = 1;

function resFieldValues() {
  const val = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id)).value;
  return { urlPattern: val('resUrl'), probability: val('resProb') };
}

function showResStep(step) {
  resStep = Math.min(RES_STEP_COUNT, Math.max(1, step));
  document.querySelectorAll('#resForm .res-step').forEach(el => {
    /** @type {HTMLElement} */ (el).hidden = Number(/** @type {HTMLElement} */ (el).dataset.step) !== resStep;
  });
  document.getElementById('resStepIndicator').textContent = `Step ${resStep} of ${RES_STEP_COUNT}`;
  /** @type {HTMLElement} */ (document.getElementById('resBackBtn')).hidden = resStep === 1;
  /** @type {HTMLElement} */ (document.getElementById('resNextBtn')).hidden = resStep === RES_STEP_COUNT;
  /** @type {HTMLElement} */ (document.getElementById('resAddBtn')).hidden = resStep !== RES_STEP_COUNT;
  updateResStepState();
  const focusId = resStep === 1 ? null : resStep === 2 ? 'resUrl' : 'resProb';
  if (focusId) document.getElementById(focusId).focus();
  else /** @type {HTMLElement} */ (document.querySelector('#resTypeChips .res-type-chip.active')
    || document.querySelector('#resTypeChips .res-type-chip'))?.focus();
}

function updateResStepState() {
  const v = resFieldValues();
  /** @type {HTMLButtonElement} */ (document.getElementById('resNextBtn')).disabled = !isResStepValid(resStep, v);
  /** @type {HTMLButtonElement} */ (document.getElementById('resAddBtn')).disabled = !isResStepValid(3, v);
  const type = /** @type {HTMLInputElement} */ (document.getElementById('resType')).value;
  const latency = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('resLatency')).value, 10);
  const release = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('resRelease')).value, 10);
  document.getElementById('resSummary').textContent = summarizeResRule({
    typeLabel: (TYPES.find(t => t.value === type) || TYPES[0]).label,
    type,
    urlPattern: v.urlPattern,
    method: capturedMethod,
    probability: v.probability,
    latencyMs: latency || null,
    releaseSec: release || null,
  });
}

function advanceResStep() {
  if (resStep < RES_STEP_COUNT && isResStepValid(resStep, resFieldValues())) showResStep(resStep + 1);
}

// Types that reuse the "Delay ms" field (rule.latencyMs) — 'latency' delays
// then lets the request through, 'stall504' delays then fulfils 504; only
// the field's label text differs between them.
const LATENCY_FIELD_TYPES = ['latency', 'stall504'];
const LATENCY_DEFAULT_BY_TYPE = { latency: '2000', stall504: '30000' };

// Shared between the add-form's #resType change listener and each edit
// row's own type <select> — shows/hides the latency field (reused by
// 'latency'/'stall504', its label switching to match) and the release-after
// field ('hang' only), and nudges the latency input to that type's sensible
// default the first time it's relevant, without clobbering a value the
// tester already customized.
function applyTypeFieldVisibility(type, latencyField, latencyInput, latencyLabel, releaseField) {
  const usesLatency = LATENCY_FIELD_TYPES.includes(type);
  latencyInput.disabled = !usesLatency;
  latencyField.classList.toggle('res-field-off', !usesLatency);
  if (usesLatency) {
    latencyLabel.textContent = type === 'stall504' ? 'Stall (ms)' : 'Delay (ms)';
    const wanted = LATENCY_DEFAULT_BY_TYPE[type];
    const other  = type === 'stall504' ? LATENCY_DEFAULT_BY_TYPE.latency : LATENCY_DEFAULT_BY_TYPE.stall504;
    if (!latencyInput.value || latencyInput.value === other) latencyInput.value = wanted;
  }
  if (releaseField) releaseField.classList.toggle('res-hidden', type !== 'hang');
}

export function initResilience() {
  const panel = document.getElementById('resiliencePanel');
  if (panel.dataset.initialized) { loadRules(); return; }
  panel.dataset.initialized = '1';

  panel.innerHTML = `
    <div class="res-toolbar">
      <span class="res-sub" id="resSubtitle">Inject failures into this session</span>
      <span class="res-spacer"></span>
      <button class="tb-btn-primary" id="resNewRuleBtn" type="button"><i class="icon-plus" aria-hidden="true"></i>Add rule</button>
    </div>
    <div class="res-wrap">
      <form class="res-form tb-form-card" id="resForm" hidden>
        <div class="tb-form-title">New failure rule</div>
        <input type="hidden" id="resType" value="error500" />
        <div class="res-step-indicator" id="resStepIndicator" aria-live="polite"></div>
        <div class="res-step" data-step="1">
          <div class="res-type-chips" id="resTypeChips" role="group" aria-label="Failure type">
            ${TYPES.map(t => `<button type="button" class="res-type-chip" data-type="${t.value}" aria-pressed="false"><i class="icon-${t.icon}" aria-hidden="true"></i>${t.label}</button>`).join('')}
          </div>
          <div class="res-type-desc" id="resTypeDesc">${TYPES[0].desc}</div>
        </div>
        <div class="res-step" data-step="2" hidden>
          <div class="res-field res-field-url">
            <label class="res-field-label" for="resUrl">URL pattern</label>
            <input class="res-input res-url" id="resUrl" type="text" value="*" placeholder="URL pattern (* = all)" spellcheck="false" />
            <span class="res-method-chip res-hidden" id="resMethodChip">Only <span id="resMethodChipLabel"></span> &middot; <button type="button" class="res-method-chip-clear" id="resMethodChipClear">clear</button></span>
          </div>
        </div>
        <div class="res-step" data-step="3" hidden>
          <div class="res-form-grid">
            <div class="res-field">
              <label class="res-field-label" for="resProb">Probability (%)</label>
              <input class="res-input res-prob" id="resProb" type="number" value="100" min="1" max="100" placeholder="%" title="Probability: 1–100%" />
            </div>
            <div class="res-field res-latency-field res-field-off" id="resLatencyField">
              <label class="res-field-label" for="resLatency" id="resLatencyLabel">Delay (ms)</label>
              <input class="res-input res-latency" id="resLatency" type="number" value="2000" min="0" placeholder="Delay ms" disabled />
            </div>
            <div class="res-field res-release-field res-hidden" id="resReleaseField">
              <label class="res-field-label" for="resRelease">Release after (s)</label>
              <input class="res-input res-release" id="resRelease" type="number" value="0" min="0" max="600" placeholder="0 = never" />
            </div>
          </div>
          <div class="res-summary" id="resSummary"></div>
        </div>
        <div class="res-form-actions">
          <button class="res-text-btn" id="resCancelBtn" type="button">Cancel</button>
          <button class="res-text-btn" id="resBackBtn" type="button" hidden>Back</button>
          <button class="tb-btn-primary" id="resNextBtn" type="button">Next</button>
          <button class="tb-btn-primary res-add-btn" id="resAddBtn" type="submit" hidden>Add rule</button>
        </div>
      </form>
      <div class="res-table" id="resTable">
        <div class="res-head" id="resHead" hidden>
          <span></span><span>Failure</span><span>Method</span><span>Pattern</span><span>Probability</span><span>Delay</span><span>Hits</span><span></span>
        </div>
        <div class="res-rules" id="resRules">
          <div class="res-empty" id="resEmpty"></div>
        </div>
      </div>
    </div>`;

  document.getElementById('resEmpty').replaceChildren(renderEmptyState({
    icon: 'zap', tone: 'warn', title: 'Resilience',
    text: 'Inject failures, hangs and latency into matching requests.',
    actionLabel: 'Add rule', onAction: () => setResFormOpen(true),
  }));
  setResType('error500');
  document.getElementById('resNewRuleBtn').addEventListener('click', () => setResFormOpen(true));
  document.getElementById('resBackBtn').addEventListener('click', () => showResStep(resStep - 1));
  document.getElementById('resNextBtn').addEventListener('click', advanceResStep);
  const resFormEl = document.getElementById('resForm');
  resFormEl.addEventListener('input', updateResStepState);
  resFormEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setResFormOpen(false); }
    else if (e.key === 'Enter' && resStep < RES_STEP_COUNT && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault(); advanceResStep();
    }
  });
  document.getElementById('resCancelBtn').addEventListener('click', () => setResFormOpen(false));
  document.querySelectorAll('#resTypeChips .res-type-chip').forEach(c =>
    c.addEventListener('click', () => { setResType(/** @type {HTMLElement} */ (c).dataset.type); updateResStepState(); }));

  // Editing the URL by hand after a "⇒ Resilience" prefill means the rule
  // is no longer scoped to the exact call it was captured from — the method
  // scoping only made sense pinned to that call, so it resets to Any.
  /** @type {HTMLInputElement} */ (document.getElementById('resUrl')).addEventListener('input', () => {
    capturedMethod = null;
    updateMethodChip();
    updateResStepState();
  });
  document.getElementById('resMethodChipClear').addEventListener('click', () => {
    capturedMethod = null;
    updateMethodChip();
    updateResStepState();
  });

  document.getElementById('resForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!getActiveId()) return;
    if (resStep < RES_STEP_COUNT) { advanceResStep(); return; }
    if (!isResStepValid(2, resFieldValues()) || !isResStepValid(3, resFieldValues())) return;
    const type = /** @type {ResilienceType} */ (/** @type {HTMLInputElement} */ (document.getElementById('resType')).value);
    /** @type {Omit<import('../src/main/resilienceManager').ResilienceRule, 'hitCount' | 'lastHitAt'>} */
    const rule = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      urlPattern: /** @type {HTMLInputElement} */ (document.getElementById('resUrl')).value.trim() || '*',
      method: capturedMethod || '*',
      probability: Math.min(1, Math.max(0.01, parseInt(/** @type {HTMLInputElement} */ (document.getElementById('resProb')).value, 10) / 100)),
      latencyMs: parseInt(/** @type {HTMLInputElement} */ (document.getElementById('resLatency')).value, 10) || (type === 'stall504' ? 30_000 : 2000),
      enabled: true,
    };
    if (type === 'hang') {
      const releaseSec = Math.min(600, Math.max(0, parseInt(/** @type {HTMLInputElement} */ (document.getElementById('resRelease')).value, 10) || 0));
      rule.releaseAfterMs = releaseSec * 1000;
    }
    if (capturedRequestHeaders) rule.requestHeaders = capturedRequestHeaders;
    if (capturedRequestBody !== null) rule.requestBody = capturedRequestBody;
    await testerBrowser.resilience.addRule(getActiveId(), rule);
    setResFormOpen(false);

    capturedMethod = null;
    capturedRequestHeaders = null;
    capturedRequestBody = null;
    updateMethodChip();

    await loadRules();
  });

  loadRules();
  // Hit counts change as traffic flows without the user re-opening this tab;
  // keep them fresh while the Resilience tab is the one being looked at.
  pollWhileVisible(() => {
    // Skip auto-refresh while a rule is being edited — the re-render would
    // replace the edit row with a read-only row, discarding in-progress edits
    // (same guard mock.js already has — #224).
    if (document.querySelector('#resRules .res-rule-row-editing')) return;
    return loadRules();
  }, 1500, () => getActiveConsoleTab() === 'resilience');
}

export async function loadRules() {
  if (!getActiveId()) return;
  const rules = await testerBrowser.resilience.getRules(getActiveId());
  renderRules(rules);
}

// #341: the tab's network/CPU throttling lives in Spoof › Advanced (markup in
// emulation.js); this wires its controls. Changes apply immediately, no reload.
export function initThrottleControls() {
  const networkSelect = /** @type {HTMLSelectElement} */ (document.getElementById('resNetworkSelect'));
  const cpuSelect      = /** @type {HTMLSelectElement} */ (document.getElementById('resCpuSelect'));
  const customFields   = document.getElementById('resCustomNetworkFields');

  networkSelect.addEventListener('change', () => {
    customFields.classList.toggle('res-hidden', networkSelect.value !== 'custom');
    if (networkSelect.value !== 'custom') applyConditionsFromForm();
  });
  cpuSelect.addEventListener('change', applyConditionsFromForm);
  document.getElementById('resCustomApplyBtn').addEventListener('click', applyConditionsFromForm);

  loadConditions();
}

// #265: reflects the active tab's own network/CPU conditions in the two
// selects (and the custom fields, if a custom network is active) — a null
// result (never touched) is shown as "No throttling" / rate 1, same as a
// brand-new tab's real, unthrottled state.
export async function loadConditions() {
  if (!getActiveId()) return;
  const networkSelect = /** @type {HTMLSelectElement} */ (document.getElementById('resNetworkSelect'));
  const cpuSelect      = /** @type {HTMLSelectElement} */ (document.getElementById('resCpuSelect'));
  const customFields   = document.getElementById('resCustomNetworkFields');
  if (!networkSelect) return; // panel not yet built
  const c = (await testerBrowser.resilience.getConditions(getActiveId())) || { network: 'none', cpuRate: 1 };

  cpuSelect.value = String(c.cpuRate);
  if (typeof c.network === 'string') {
    networkSelect.value = c.network;
    customFields.classList.add('res-hidden');
  } else {
    networkSelect.value = 'custom';
    customFields.classList.remove('res-hidden');
    /** @type {HTMLInputElement} */ (document.getElementById('resCustomLatency')).value  = c.network.custom.latency;
    /** @type {HTMLInputElement} */ (document.getElementById('resCustomDownload')).value = c.network.custom.downloadKbps;
    /** @type {HTMLInputElement} */ (document.getElementById('resCustomUpload')).value   = c.network.custom.uploadKbps;
  }
}

async function applyConditionsFromForm() {
  if (!getActiveId()) return;
  const networkSelect = /** @type {HTMLSelectElement} */ (document.getElementById('resNetworkSelect'));
  const cpuSelect      = /** @type {HTMLSelectElement} */ (document.getElementById('resCpuSelect'));
  /** @type {import('../src/main/networkConditions').NetworkSelection} */
  const network = networkSelect.value === 'custom'
    ? { custom: {
        latency:      parseInt(/** @type {HTMLInputElement} */ (document.getElementById('resCustomLatency')).value, 10) || 0,
        downloadKbps: parseInt(/** @type {HTMLInputElement} */ (document.getElementById('resCustomDownload')).value, 10) || 0,
        uploadKbps:   parseInt(/** @type {HTMLInputElement} */ (document.getElementById('resCustomUpload')).value, 10) || 0,
      } }
    : /** @type {import('../src/main/networkConditions').NetworkPresetKey} */ (networkSelect.value);
  await testerBrowser.resilience.setConditions(getActiveId(), { network, cpuRate: Number(cpuSelect.value) });
  // setConditions() only updates main-process state — nothing pushes a
  // session-list refresh to the renderer on its own (unlike title/favicon,
  // which have their own dedicated push channels), so the tab strip's
  // throttled indicator would otherwise sit stale until some unrelated
  // action happened to call refreshTabs() next.
  await refreshTabs();
}

function renderRules(rules) {
  const container = document.getElementById('resRules');
  const empty = document.getElementById('resEmpty');
  if (!container) return;
  container.querySelectorAll('.res-rule-row').forEach(r => r.remove());
  const sub = document.getElementById('resSubtitle');
  if (sub) {
    const name = document.querySelector('.tab.active .tab-name')?.textContent;
    sub.textContent = name ? `Inject failures into ${name}` : 'Inject failures into this session';
  }
  const head = document.getElementById('resHead');
  if (head) head.hidden = rules.length === 0;

  if (rules.length === 0) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  for (const rule of rules) {
    container.appendChild(buildRuleRow(rule));
  }
}

function buildRuleRow(rule) {
  const type = TYPES.find(t => t.value === rule.type);
  const typeLabel = type?.label ?? rule.type;
  const probLabel = Math.round(rule.probability * 100) + '%';
  const usesDelay = LATENCY_FIELD_TYPES.includes(rule.type);
  const delayLabel = usesDelay ? `${rule.latencyMs} ms`
    : rule.type === 'hang' && rule.releaseAfterMs ? `${Math.round(rule.releaseAfterMs / 1000)} s`
    : '—';
  const row = document.createElement('div');
  row.className = `res-rule-row${rule.enabled ? '' : ' rule-row-disabled'}`;
  row.dataset.id = rule.id;
  row.innerHTML = `
    <label class="res-toggle" title="Enable/disable">
      <input type="checkbox" class="res-enable" aria-label="Enable rule" ${rule.enabled ? 'checked' : ''} />
    </label>
    <span class="res-rule-type"><i class="icon-${type?.icon ?? 'zap'}" aria-hidden="true"></i>${escHtml(typeLabel)}</span>
    <span class="res-rule-method">${escHtml(rule.method && rule.method !== '*' ? rule.method : 'ANY')}</span>
    <span class="res-rule-url" title="${escHtml(rule.urlPattern)}">${escHtml(rule.urlPattern)}</span>
    <span class="res-prob-badge">${probLabel}</span>
    <span class="res-rule-delay">${delayLabel}</span>
    <span class="res-hits-badge${rule.hitCount ? ' res-hits-active' : ''}" title="${rule.lastHitAt ? 'Last hit ' + escHtml(formatAgo(rule.lastHitAt)) : 'Not hit yet'}">${rule.hitCount || 0}</span>
    <div class="res-rule-actions">
      <button class="res-icon-btn res-network-btn" title="View matching calls in the Network tab" aria-label="View in Network"><i class="icon-arrow-right" aria-hidden="true"></i></button>
      <button class="res-icon-btn res-edit-btn" title="Edit rule" aria-label="Edit rule"><i class="icon-pencil" aria-hidden="true"></i></button>
      <button class="res-icon-btn res-del-btn" title="Remove" aria-label="Remove rule"><i class="icon-trash-2" aria-hidden="true"></i></button>
    </div>`;

  row.querySelector('.res-enable').addEventListener('change', async (e) => {
    await testerBrowser.resilience.toggleRule(getActiveId(), rule.id, /** @type {HTMLInputElement} */ (e.target).checked);
    await loadRules();
  });
  row.querySelector('.res-del-btn').addEventListener('click', async () => {
    await testerBrowser.resilience.removeRule(getActiveId(), rule.id);
    await loadRules();
  });
  row.querySelector('.res-network-btn').addEventListener('click', () => viewRuleInNetwork(rule));
  row.querySelector('.res-edit-btn').addEventListener('click', () => {
    row.replaceWith(buildEditRow(rule));
  });
  return row;
}

// Read-only provenance from the captured call a rule was created from — never
// editable, never sent anywhere or matched against, just context for why
// this rule exists and what it was pointed at. Omitted entirely for a rule
// composed by hand (no requestHeaders/requestBody to show).
function buildProvenanceHtml(rule) {
  const headerEntries = Object.entries(rule.requestHeaders || {});
  if (headerEntries.length === 0 && !rule.requestBody) return '';
  const headersHtml = headerEntries.length
    ? headerEntries.map(([k, v]) => `<div class="res-provenance-row"><span class="res-provenance-key">${escHtml(k)}</span>: ${escHtml(String(v))}</div>`).join('')
    : '';
  const bodyHtml = rule.requestBody
    ? `<pre class="res-provenance-body">${escHtml(rule.requestBody)}</pre>` : '';
  return `<div class="res-provenance" title="From the captured call this rule was created from — read-only, never matched against">
    <div class="res-provenance-label">Captured request${rule.method && rule.method !== '*' ? ` (${escHtml(rule.method)})` : ''}</div>
    ${headersHtml}
    ${bodyHtml}
  </div>`;
}

function buildEditRow(rule) {
  const row = document.createElement('div');
  row.className = 'res-rule-row res-rule-row-editing';
  row.dataset.id = rule.id;
  row.innerHTML = `
    <select class="res-select res-edit-type">
      ${TYPES.map(t => `<option value="${t.value}" ${t.value === rule.type ? 'selected' : ''}>${t.label}</option>`).join('')}
    </select>
    <input class="res-input res-edit-url" type="text" value="${escHtml(rule.urlPattern)}" spellcheck="false" />
    <input class="res-input res-edit-prob" type="number" min="1" max="100" value="${Math.round(rule.probability * 100)}" title="Probability %" />
    <input class="res-input res-edit-latency${LATENCY_FIELD_TYPES.includes(rule.type) ? '' : ' res-hidden'}" type="number" min="0" value="${rule.latencyMs ?? (rule.type === 'stall504' ? 30_000 : 2000)}" title="${rule.type === 'stall504' ? 'Stall ms' : 'Delay ms'}" />
    <input class="res-input res-edit-release${rule.type === 'hang' ? '' : ' res-hidden'}" type="number" min="0" max="600" value="${rule.releaseAfterMs ? Math.round(rule.releaseAfterMs / 1000) : 0}" title="Release after (s) — 0 = never" />
    <button class="res-btn res-save-btn" title="Save">Save</button>
    <button class="res-btn res-cancel-btn" title="Cancel">Cancel</button>
    ${buildProvenanceHtml(rule)}`;

  const typeSel = /** @type {HTMLSelectElement} */ (row.querySelector('.res-edit-type'));
  const latencyInput = /** @type {HTMLInputElement} */ (row.querySelector('.res-edit-latency'));
  const releaseInput = /** @type {HTMLInputElement} */ (row.querySelector('.res-edit-release'));
  typeSel.addEventListener('change', () => {
    latencyInput.classList.toggle('res-hidden', !LATENCY_FIELD_TYPES.includes(typeSel.value));
    latencyInput.title = typeSel.value === 'stall504' ? 'Stall ms' : 'Delay ms';
    releaseInput.classList.toggle('res-hidden', typeSel.value !== 'hang');
  });

  row.querySelector('.res-cancel-btn').addEventListener('click', () => {
    row.replaceWith(buildRuleRow(rule));
  });
  row.querySelector('.res-save-btn').addEventListener('click', async () => {
    const type = /** @type {ResilienceType} */ (typeSel.value);
    const patch = {
      type,
      urlPattern: /** @type {HTMLInputElement} */ (row.querySelector('.res-edit-url')).value.trim() || '*',
      probability: Math.min(1, Math.max(0.01, parseInt(/** @type {HTMLInputElement} */ (row.querySelector('.res-edit-prob')).value, 10) / 100)),
      latencyMs: parseInt(latencyInput.value, 10) || (type === 'stall504' ? 30_000 : 2000),
    };
    if (type === 'hang') {
      const releaseSec = Math.min(600, Math.max(0, parseInt(releaseInput.value, 10) || 0));
      patch.releaseAfterMs = releaseSec * 1000;
    }
    await testerBrowser.resilience.updateRule(getActiveId(), rule.id, patch);
    await loadRules();
  });
  return row;
}

// Jumps to the Network tab and filters it down to calls matching this rule's
// URL pattern, so the user can see exactly which traffic the rule affects.
function viewRuleInNetwork(rule) {
  const filterInput = /** @type {HTMLInputElement} */ (document.getElementById('networkFilterText'));
  if (filterInput) {
    // The network filter matches plain substrings, not globs — strip glob
    // wildcards so a pattern like "*/api/*" becomes the substring "/api/".
    filterInput.value = rule.urlPattern === '*' ? '' : rule.urlPattern.replace(/\*/g, '');
  }
  switchConsoleTab('network'); // re-renders the timeline using the filter set above
}
