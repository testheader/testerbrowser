/* global testerBrowser */
import { getActiveId } from './tabs.js';
import { getActiveConsoleTab, switchConsoleTab } from './console-tabs.js';

const TYPES = [
  { value: 'error500',  label: '500 Error',           desc: 'Return HTTP 500 Internal Server Error' },
  { value: 'timeout',   label: 'Timeout (504)',        desc: 'Return HTTP 504 Gateway Timeout' },
  { value: 'offline',   label: 'Offline',              desc: 'Fail request as if network is disconnected' },
  { value: 'missing',   label: '404 Missing',          desc: 'Return HTTP 404 Not Found' },
  { value: 'corrupt',   label: 'Corrupt Response',     desc: 'Return 200 with garbled binary body' },
  { value: 'latency',   label: 'Add Latency',          desc: 'Delay the request by the specified ms' },
  { value: 'random500', label: 'Random 500 (% chance)', desc: 'Randomly return 500, use probability below' },
];

export function initResilience() {
  const panel = document.getElementById('resiliencePanel');
  if (panel.dataset.initialized) { loadRules(); return; }
  panel.dataset.initialized = '1';

  panel.innerHTML = `
    <div class="res-wrap">
      <div class="res-col res-col-left">
      <div class="res-guide">
        <p>Resilience testing lets you inject network failures into the active session to verify how your app behaves under real-world conditions. Rules only affect the current session and apply immediately.</p>
        <ol class="res-guide-steps">
          <li>Choose a failure type</li>
          <li>Set a URL pattern (glob) to target specific requests</li>
          <li>Set the probability %</li>
          <li>Click <strong>Add rule</strong></li>
        </ol>
      </div>
      <form class="res-form" id="resForm">
        <div class="res-form-row">
          <div class="res-field">
            <label class="res-field-label" for="resType">Type</label>
            <select class="res-select" id="resType">
              ${TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('')}
            </select>
          </div>
          <div class="res-field res-field-url">
            <label class="res-field-label" for="resUrl">URL pattern</label>
            <input class="res-input res-url" id="resUrl" type="text" value="*" placeholder="URL pattern (* = all)" spellcheck="false" />
          </div>
          <div class="res-field">
            <label class="res-field-label" for="resProb">Probability %</label>
            <input class="res-input res-prob" id="resProb" type="number" value="100" min="1" max="100" placeholder="%" title="Probability: 1–100%" />
          </div>
          <div class="res-field res-latency-field res-hidden" id="resLatencyField">
            <label class="res-field-label" for="resLatency">Delay ms</label>
            <input class="res-input res-latency" id="resLatency" type="number" value="2000" min="0" placeholder="Delay ms" />
          </div>
          <button class="res-btn res-add-btn" type="submit">Add rule</button>
        </div>
        <div class="res-type-desc" id="resTypeDesc">${TYPES[0].desc}</div>
        <div class="res-field-hints">
          <span class="res-field-hint">URL pattern &mdash; use <code>*</code> to match all requests, or e.g. <code>*/api/*</code> to target only API calls. Supports glob wildcards.</span>
          <span class="res-field-hint">Probability &mdash; 1&ndash;100%. At 100% every matching request is affected; at 50% roughly half are.</span>
        </div>
      </form>
      </div>
      <div class="res-col res-col-right">
        <div class="res-rules-title">Active rules</div>
        <div class="res-rules" id="resRules">
          <div class="res-empty" id="resEmpty">Add a rule to intercept requests.</div>
        </div>
      </div>
    </div>`;

  document.getElementById('resType').addEventListener('change', (e) => {
    document.getElementById('resLatencyField').classList.toggle('res-hidden', e.target.value !== 'latency');
    const t = TYPES.find(t => t.value === e.target.value);
    if (t) document.getElementById('resTypeDesc').textContent = t.desc;
  });

  document.getElementById('resForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!getActiveId()) return;
    const type = document.getElementById('resType').value;
    const rule = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      urlPattern: document.getElementById('resUrl').value.trim() || '*',
      probability: Math.min(1, Math.max(0.01, parseInt(document.getElementById('resProb').value, 10) / 100)),
      latencyMs: parseInt(document.getElementById('resLatency').value, 10) || 2000,
      enabled: true,
    };
    await testerBrowser.resilience.addRule(getActiveId(), rule);
    await loadRules();
  });

  loadRules();
  // Hit counts change as traffic flows without the user re-opening this tab;
  // keep them fresh while the Resilience tab is the one being looked at.
  setInterval(() => { if (getActiveConsoleTab() === 'resilience') loadRules(); }, 1500);
}

export async function loadRules() {
  if (!getActiveId()) return;
  const rules = await testerBrowser.resilience.getRules(getActiveId());
  renderRules(rules);
}

function renderRules(rules) {
  const container = document.getElementById('resRules');
  const empty = document.getElementById('resEmpty');
  if (!container) return;
  container.querySelectorAll('.res-rule-row').forEach(r => r.remove());

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
  const typeLabel = TYPES.find(t => t.value === rule.type)?.label ?? rule.type;
  const probLabel = Math.round(rule.probability * 100) + '%';
  const extra = rule.type === 'latency' ? ` ${rule.latencyMs}ms` : '';
  const row = document.createElement('div');
  row.className = 'res-rule-row';
  row.dataset.id = rule.id;
  row.innerHTML = `
    <label class="res-toggle" title="Enable/disable">
      <input type="checkbox" class="res-enable" ${rule.enabled ? 'checked' : ''} />
      <span class="res-toggle-label"></span>
    </label>
    <span class="res-rule-type res-badge">${typeLabel}${extra}</span>
    <span class="res-rule-url" title="${rule.urlPattern}">${rule.urlPattern}</span>
    <span class="res-badge res-prob-badge">${probLabel}</span>
    <span class="res-badge res-hits-badge${rule.hitCount ? ' res-hits-active' : ''}" title="${rule.lastHitAt ? 'Last hit ' + new Date(rule.lastHitAt).toLocaleTimeString() : 'Not hit yet'}">Hits: ${rule.hitCount || 0}</span>
    <button class="res-btn res-network-btn" title="View matching calls in the Network tab">⇒ Network</button>
    <button class="res-btn res-edit-btn" title="Edit rule">✎</button>
    <button class="res-btn res-del-btn" title="Remove">✕</button>`;

  row.querySelector('.res-enable').addEventListener('change', async (e) => {
    await testerBrowser.resilience.toggleRule(getActiveId(), rule.id, e.target.checked);
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

function buildEditRow(rule) {
  const row = document.createElement('div');
  row.className = 'res-rule-row res-rule-row-editing';
  row.dataset.id = rule.id;
  row.innerHTML = `
    <select class="res-select res-edit-type">
      ${TYPES.map(t => `<option value="${t.value}" ${t.value === rule.type ? 'selected' : ''}>${t.label}</option>`).join('')}
    </select>
    <input class="res-input res-edit-url" type="text" value="${rule.urlPattern}" spellcheck="false" />
    <input class="res-input res-edit-prob" type="number" min="1" max="100" value="${Math.round(rule.probability * 100)}" title="Probability %" />
    <input class="res-input res-edit-latency${rule.type === 'latency' ? '' : ' res-hidden'}" type="number" min="0" value="${rule.latencyMs ?? 2000}" title="Delay ms" />
    <button class="res-btn res-save-btn" title="Save">Save</button>
    <button class="res-btn res-cancel-btn" title="Cancel">Cancel</button>`;

  const typeSel = row.querySelector('.res-edit-type');
  const latencyInput = row.querySelector('.res-edit-latency');
  typeSel.addEventListener('change', () => {
    latencyInput.classList.toggle('res-hidden', typeSel.value !== 'latency');
  });

  row.querySelector('.res-cancel-btn').addEventListener('click', () => {
    row.replaceWith(buildRuleRow(rule));
  });
  row.querySelector('.res-save-btn').addEventListener('click', async () => {
    const patch = {
      type: typeSel.value,
      urlPattern: row.querySelector('.res-edit-url').value.trim() || '*',
      probability: Math.min(1, Math.max(0.01, parseInt(row.querySelector('.res-edit-prob').value, 10) / 100)),
      latencyMs: parseInt(latencyInput.value, 10) || 2000,
    };
    await testerBrowser.resilience.updateRule(getActiveId(), rule.id, patch);
    await loadRules();
  });
  return row;
}

// Jumps to the Network tab and filters it down to calls matching this rule's
// URL pattern, so the user can see exactly which traffic the rule affects.
function viewRuleInNetwork(rule) {
  const filterInput = document.getElementById('networkFilterText');
  if (filterInput) {
    // The network filter matches plain substrings, not globs — strip glob
    // wildcards so a pattern like "*/api/*" becomes the substring "/api/".
    filterInput.value = rule.urlPattern === '*' ? '' : rule.urlPattern.replace(/\*/g, '');
  }
  switchConsoleTab('network'); // re-renders the timeline using the filter set above
}
