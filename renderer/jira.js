/* global testerBrowser */
import { state } from './state.js';

let initialized = false;

export function initJira() {
  const panel = document.getElementById('jiraPanel');
  if (initialized) return;
  initialized = true;

  panel.innerHTML = `
    <div class="jira-wrap">
      <div class="jira-settings-bar">
        <span class="jira-title">Jira</span>
        <button class="jira-icon-btn" id="jiraSettingsBtn" title="Configure Jira">&#9881;</button>
      </div>

      <div id="jiraSetupView" hidden>
        <div class="jira-setup-form">
          <div class="jira-field">
            <label class="jira-label">Jira Base URL</label>
            <input class="jira-input" id="jiraBaseUrl" type="url" placeholder="https://yourorg.atlassian.net" />
          </div>
          <div class="jira-field">
            <label class="jira-label">Email</label>
            <input class="jira-input" id="jiraEmail" type="email" placeholder="you@example.com" />
          </div>
          <div class="jira-field">
            <label class="jira-label">API Token</label>
            <input class="jira-input" id="jiraApiToken" type="password" placeholder="API token from id.atlassian.com" />
          </div>
          <div class="jira-field">
            <label class="jira-label">Default Project Key</label>
            <input class="jira-input" id="jiraProjectKey" type="text" placeholder="e.g. PROJ" />
          </div>
          <div class="jira-setup-actions">
            <button class="jira-btn jira-btn-primary" id="jiraSaveSettingsBtn">Save</button>
            <button class="jira-btn" id="jiraCancelSettingsBtn">Cancel</button>
            <span class="jira-msg" id="jiraSettingsMsg"></span>
          </div>
        </div>
      </div>

      <div id="jiraMainView">
        <div class="jira-ticket-bar">
          <input class="jira-input jira-ticket-input" id="jiraTicketKey" type="text" placeholder="Ticket key (e.g. PROJ-123)" />
          <button class="jira-btn jira-btn-primary" id="jiraFetchBtn">Load</button>
        </div>
        <div id="jiraTicketDisplay" class="jira-ticket-display" hidden></div>
        <div class="jira-actions-bar" hidden id="jiraActionsBar">
          <button class="jira-btn jira-btn-bug" id="jiraAddBugBtn">&#43; Add Bug</button>
        </div>
        <div id="jiraBugForm" class="jira-bug-form" hidden>
          <div class="jira-field">
            <label class="jira-label">Summary</label>
            <input class="jira-input" id="jiraBugSummary" type="text" placeholder="Bug summary" />
          </div>
          <div class="jira-field">
            <label class="jira-label">Description</label>
            <textarea class="jira-input jira-textarea" id="jiraBugDesc" rows="4" placeholder="Steps to reproduce, expected vs actual…"></textarea>
          </div>
          <div class="jira-setup-actions">
            <button class="jira-btn jira-btn-primary" id="jiraSubmitBugBtn">Submit Bug</button>
            <button class="jira-btn" id="jiraCancelBugBtn">Cancel</button>
            <span class="jira-msg" id="jiraBugMsg"></span>
          </div>
        </div>
        <div id="jiraNotConfigured" class="jira-not-configured" hidden>
          <span>Configure your Jira workspace in settings above.</span>
        </div>
      </div>
    </div>`;

  loadSettings();

  document.getElementById('jiraSettingsBtn').addEventListener('click', openSettings);
  document.getElementById('jiraSaveSettingsBtn').addEventListener('click', saveSettings);
  document.getElementById('jiraCancelSettingsBtn').addEventListener('click', closeSettings);
  document.getElementById('jiraFetchBtn').addEventListener('click', fetchTicket);
  document.getElementById('jiraTicketKey').addEventListener('keydown', e => { if (e.key === 'Enter') fetchTicket(); });
  document.getElementById('jiraAddBugBtn').addEventListener('click', openBugForm);
  document.getElementById('jiraCancelBugBtn').addEventListener('click', closeBugForm);
  document.getElementById('jiraSubmitBugBtn').addEventListener('click', submitBug);
}

async function loadSettings() {
  const s = await testerBrowser.jira.getSettings();
  const configured = s.baseUrl && s.email && s.apiToken;
  document.getElementById('jiraNotConfigured').hidden = !!configured;
  if (configured) {
    document.getElementById('jiraBaseUrl').value = s.baseUrl;
    document.getElementById('jiraEmail').value = s.email;
    document.getElementById('jiraApiToken').value = s.apiToken;
    document.getElementById('jiraProjectKey').value = s.projectKey || '';
  }
}

function openSettings() {
  document.getElementById('jiraSetupView').hidden = false;
  document.getElementById('jiraMainView').hidden = true;
}

function closeSettings() {
  document.getElementById('jiraSetupView').hidden = true;
  document.getElementById('jiraMainView').hidden = false;
}

async function saveSettings() {
  const s = {
    baseUrl: document.getElementById('jiraBaseUrl').value.trim().replace(/\/$/, ''),
    email: document.getElementById('jiraEmail').value.trim(),
    apiToken: document.getElementById('jiraApiToken').value.trim(),
    projectKey: document.getElementById('jiraProjectKey').value.trim().toUpperCase(),
  };
  const msg = document.getElementById('jiraSettingsMsg');
  if (!s.baseUrl || !s.email || !s.apiToken) {
    msg.textContent = 'Base URL, email and API token are required.';
    msg.className = 'jira-msg jira-msg-error';
    return;
  }
  await testerBrowser.jira.saveSettings(s);
  msg.textContent = 'Saved.';
  msg.className = 'jira-msg jira-msg-ok';
  document.getElementById('jiraNotConfigured').hidden = true;
  setTimeout(closeSettings, 800);
}

async function fetchTicket() {
  const key = document.getElementById('jiraTicketKey').value.trim().toUpperCase();
  if (!key) return;
  const display = document.getElementById('jiraTicketDisplay');
  display.hidden = false;
  display.innerHTML = '<span class="jira-loading">Loading…</span>';
  document.getElementById('jiraActionsBar').hidden = true;
  closeBugForm();

  const result = await testerBrowser.jira.fetchTicket(key);
  if (!result.ok) {
    display.innerHTML = `<span class="jira-error">${escHtml(result.error)}</span>`;
    return;
  }

  const f = result.data.fields;
  const summary = f.summary ?? '(no summary)';
  const status = f.status?.name ?? '—';
  const assignee = f.assignee?.displayName ?? 'Unassigned';
  const priority = f.priority?.name ?? '—';
  const rawDesc = extractText(f.description);
  const desc = rawDesc ? rawDesc.slice(0, 400) + (rawDesc.length > 400 ? '…' : '') : '(no description)';

  display.innerHTML = `
    <div class="jira-ticket-card">
      <div class="jira-ticket-key">${escHtml(key)}</div>
      <div class="jira-ticket-summary">${escHtml(summary)}</div>
      <div class="jira-ticket-meta">
        <span class="jira-badge">${escHtml(status)}</span>
        <span class="jira-meta-item">&#128100; ${escHtml(assignee)}</span>
        <span class="jira-meta-item">&#9650; ${escHtml(priority)}</span>
      </div>
      <div class="jira-ticket-desc">${escHtml(desc)}</div>
    </div>`;

  document.getElementById('jiraActionsBar').hidden = false;
}

function openBugForm() {
  const form = document.getElementById('jiraBugForm');
  form.hidden = false;
  const currentUrl = document.getElementById('urlbar')?.value ?? '';
  const currentTitle = state.tabTitles[state.activeId] ?? '';
  document.getElementById('jiraBugSummary').value = `Bug in ${currentTitle || currentUrl}`;
  document.getElementById('jiraBugDesc').value =
    `URL: ${currentUrl}\n\nSteps to reproduce:\n1. \n\nExpected:\n\nActual:\n`;
  document.getElementById('jiraBugMsg').textContent = '';
}

function closeBugForm() {
  document.getElementById('jiraBugForm').hidden = true;
}

async function submitBug() {
  const summary = document.getElementById('jiraBugSummary').value.trim();
  const desc = document.getElementById('jiraBugDesc').value.trim();
  const msg = document.getElementById('jiraBugMsg');
  if (!summary) {
    msg.textContent = 'Summary is required.';
    msg.className = 'jira-msg jira-msg-error';
    return;
  }
  msg.textContent = 'Creating…';
  msg.className = 'jira-msg';

  const result = await testerBrowser.jira.createIssue(summary, desc);
  if (!result.ok) {
    msg.textContent = `Error: ${result.error}`;
    msg.className = 'jira-msg jira-msg-error';
    return;
  }
  msg.textContent = `Created: ${result.key}`;
  msg.className = 'jira-msg jira-msg-ok';
  setTimeout(closeBugForm, 1500);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (Array.isArray(node.content)) return node.content.map(extractText).join(' ');
  return '';
}
