/* global testerBrowser */
import { escHtml } from './utils.js';
import { getActiveId, getTabTitle } from './tabs.js';

let initialized = false;
let currentHasToken = false;
let cachedSettings = null;
let lastFetchedKey = null;

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
            <div class="jira-token-saved" id="jiraTokenSaved" hidden>
              <span>Token saved &#10003;</span>
              <button type="button" class="jira-btn" id="jiraTokenReplaceBtn">Replace</button>
            </div>
            <input class="jira-input" id="jiraApiToken" type="password" placeholder="API token from id.atlassian.com" />
          </div>
          <div class="jira-field">
            <label class="jira-label">Default Project Key</label>
            <input class="jira-input" id="jiraProjectKey" type="text" placeholder="e.g. PROJ" />
          </div>
          <div class="jira-field">
            <label class="jira-label">Issue Type</label>
            <input class="jira-input" id="jiraIssueType" type="text" placeholder="Bug" />
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
  document.getElementById('jiraTokenReplaceBtn').addEventListener('click', () => setTokenEditing(true));
  document.getElementById('jiraFetchBtn').addEventListener('click', fetchTicket);
  document.getElementById('jiraTicketKey').addEventListener('keydown', e => { if (e.key === 'Enter') fetchTicket(); });
  document.getElementById('jiraAddBugBtn').addEventListener('click', openBugForm);
  document.getElementById('jiraCancelBugBtn').addEventListener('click', closeBugForm);
  document.getElementById('jiraSubmitBugBtn').addEventListener('click', submitBug);
}

async function loadSettings() {
  const s = await testerBrowser.jira.getSettings();
  cachedSettings = s;
  currentHasToken = !!s.hasToken;
  const configured = s.baseUrl && s.email && currentHasToken;
  document.getElementById('jiraNotConfigured').hidden = !!configured;
  document.getElementById('jiraBaseUrl').value = s.baseUrl || '';
  document.getElementById('jiraEmail').value = s.email || '';
  document.getElementById('jiraProjectKey').value = s.projectKey || '';
  document.getElementById('jiraIssueType').value = s.issueType || 'Bug';
  setTokenEditing(!currentHasToken);
}

// A saved token is never sent back to the renderer (#267) — show a "Token
// saved" indicator with a Replace action instead of a password field the
// real value could never actually populate.
function setTokenEditing(editing) {
  document.getElementById('jiraTokenSaved').hidden = editing;
  document.getElementById('jiraApiToken').hidden = !editing;
  if (editing) document.getElementById('jiraApiToken').value = '';
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
  const tokenInput = document.getElementById('jiraApiToken');
  const typedToken = tokenInput.hidden ? '' : tokenInput.value.trim();
  const s = {
    baseUrl: document.getElementById('jiraBaseUrl').value.trim().replace(/\/$/, ''),
    email: document.getElementById('jiraEmail').value.trim(),
    projectKey: document.getElementById('jiraProjectKey').value.trim().toUpperCase(),
    issueType: document.getElementById('jiraIssueType').value.trim() || 'Bug',
  };
  if (typedToken) s.apiToken = typedToken;

  const msg = document.getElementById('jiraSettingsMsg');
  if (!s.baseUrl || !s.email || (!currentHasToken && !typedToken)) {
    msg.textContent = 'Base URL, email and API token are required.';
    msg.className = 'jira-msg jira-msg-error';
    return;
  }
  const result = await testerBrowser.jira.saveSettings(s);
  if (!result?.ok) {
    msg.textContent = result?.error || 'Could not save settings.';
    msg.className = 'jira-msg jira-msg-error';
    return;
  }
  msg.textContent = 'Saved.';
  msg.className = 'jira-msg jira-msg-ok';
  document.getElementById('jiraNotConfigured').hidden = true;
  await loadSettings();
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
  lastFetchedKey = null;

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

  lastFetchedKey = key;
  document.getElementById('jiraActionsBar').hidden = false;
}

function openBugForm() {
  const form = document.getElementById('jiraBugForm');
  form.hidden = false;
  const currentUrl = document.getElementById('urlbar')?.value ?? '';
  const currentTitle = getTabTitle(getActiveId()) ?? '';
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

  const result = await testerBrowser.jira.createIssue(summary, desc, lastFetchedKey ? { linkTo: lastFetchedKey } : undefined);
  if (!result.ok) {
    msg.textContent = `Error: ${result.error}`;
    msg.className = 'jira-msg jira-msg-error';
    return;
  }

  const issueUrl = `${cachedSettings?.baseUrl ?? ''}/browse/${result.key}`;
  const linkNote = result.linkError
    ? ` (could not link to ${escHtml(lastFetchedKey)}: ${escHtml(result.linkError)})`
    : '';
  msg.innerHTML = `Created: <a href="#" id="jiraCreatedLink">${escHtml(result.key)}</a>${linkNote}`;
  msg.className = 'jira-msg jira-msg-ok';
  document.getElementById('jiraCreatedLink').addEventListener('click', (e) => {
    e.preventDefault();
    testerBrowser.app.openExternal(issueUrl);
  });
  setTimeout(closeBugForm, 1500);
}

function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (Array.isArray(node.content)) return node.content.map(extractText).join(' ');
  return '';
}
