/* global testerBrowser */
import { state } from './state.js';

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
          <button class="mock-btn mock-add-btn" type="submit">Add rule</button>
        </div>
      </form>
      <div class="mock-rules" id="mockRules">
        <div class="mock-empty" id="mockEmpty">Add a rule above to intercept requests.</div>
      </div>
    </div>`;

  document.getElementById('mockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.activeId) return;
    const rule = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      urlPattern: document.getElementById('mockUrl').value.trim(),
      method: document.getElementById('mockMethod').value,
      statusCode: parseInt(document.getElementById('mockStatus').value, 10) || 200,
      body: document.getElementById('mockBody').value,
      enabled: true,
    };
    await testerBrowser.mock.addRule(state.activeId, rule);
    document.getElementById('mockUrl').value = '';
    document.getElementById('mockBody').value = '';
    await loadRules();
  });

  loadRules();
  // Hit counts change as traffic flows without the user re-opening this tab;
  // keep them fresh while the Mock tab is the one being looked at.
  setInterval(() => { if (state.activeConsoleTab === 'mock') loadRules(); }, 1500);
}

async function loadRules() {
  if (!state.activeId) return;
  const rules = await testerBrowser.mock.getRules(state.activeId);
  renderRules(rules);
}

function renderRules(rules) {
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
    const row = document.createElement('div');
    row.className = 'mock-rule-row';
    row.dataset.id = rule.id;
    row.innerHTML = `
      <label class="mock-toggle" title="Enable/disable">
        <input type="checkbox" class="mock-enable" ${rule.enabled ? 'checked' : ''} />
        <span class="mock-toggle-label"></span>
      </label>
      <span class="mock-rule-method mock-badge">${rule.method}</span>
      <span class="mock-rule-url" title="${rule.urlPattern}">${rule.urlPattern}</span>
      <span class="mock-badge mock-status-badge">${rule.statusCode}</span>
      <span class="mock-rule-body" title="${rule.body}">${rule.body.slice(0, 40)}${rule.body.length > 40 ? '…' : ''}</span>
      <span class="mock-badge mock-hits-badge${rule.hitCount ? ' mock-hits-active' : ''}" title="${rule.lastHitAt ? 'Last hit ' + new Date(rule.lastHitAt).toLocaleTimeString() : 'Not hit yet'}">Hits: ${rule.hitCount || 0}</span>
      <button class="mock-btn mock-del-btn" title="Remove">✕</button>`;

    row.querySelector('.mock-enable').addEventListener('change', async (e) => {
      await testerBrowser.mock.toggleRule(state.activeId, rule.id, e.target.checked);
    });
    row.querySelector('.mock-del-btn').addEventListener('click', async () => {
      await testerBrowser.mock.removeRule(state.activeId, rule.id);
      await loadRules();
    });
    container.appendChild(row);
  }
}
