/* global testerBrowser */
import { state } from './state.js';

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
    if (!state.activeId) return;
    const type = document.getElementById('resType').value;
    const rule = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      urlPattern: document.getElementById('resUrl').value.trim() || '*',
      probability: Math.min(1, Math.max(0.01, parseInt(document.getElementById('resProb').value, 10) / 100)),
      latencyMs: parseInt(document.getElementById('resLatency').value, 10) || 2000,
      enabled: true,
    };
    await testerBrowser.resilience.addRule(state.activeId, rule);
    await loadRules();
  });

  loadRules();
  // Hit counts change as traffic flows without the user re-opening this tab;
  // keep them fresh while the Resilience tab is the one being looked at.
  setInterval(() => { if (state.activeConsoleTab === 'resilience') loadRules(); }, 1500);
}

export async function loadRules() {
  if (!state.activeId) return;
  const rules = await testerBrowser.resilience.getRules(state.activeId);
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
      <button class="res-btn res-del-btn" title="Remove">✕</button>`;

    row.querySelector('.res-enable').addEventListener('change', async (e) => {
      await testerBrowser.resilience.toggleRule(state.activeId, rule.id, e.target.checked);
    });
    row.querySelector('.res-del-btn').addEventListener('click', async () => {
      await testerBrowser.resilience.removeRule(state.activeId, rule.id);
      await loadRules();
    });
    container.appendChild(row);
  }
}
