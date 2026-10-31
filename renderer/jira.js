/* global testerBrowser */
import { escHtml } from './utils.js';
import { getActiveId, getTabTitle } from './tabs.js';
import { switchConsoleTab } from './console-tabs.js';
import { renderEmptyState } from './empty-state.js';
import { renderFlowSteps } from './flow-steps.js';
import { jiraFlowStep } from './flow-logic.js';
import { adfText, extractAcceptanceCriteria, jiraHost } from './jira-logic.js';

let initialized = false;
let currentHasToken = false;
let cachedSettings = null;
let lastFetchedKey = null;
let jiraConfigured = false;

export function initJira() {
  const panel = document.getElementById('jiraPanel');
  if (initialized) return;
  initialized = true;

  panel.innerHTML = `
    <div class="jira-wrap">
      <div class="jira-toolbar" id="jiraToolbar">
        <label class="jira-key-field"><i class="icon-ticket" aria-hidden="true"></i>
          <input class="jira-ticket-input" id="jiraTicketKey" type="text" placeholder="PROJ-123" aria-label="Ticket key" spellcheck="false" />
        </label>
        <button class="net-chip" id="jiraFetchBtn" type="button">Load</button>
        <span class="jira-spacer"></span>
        <span class="jira-conn" id="jiraConn" hidden><span class="jira-conn-dot" aria-hidden="true"></span><span id="jiraConnHost"></span></span>
        <button class="jira-icon-btn" id="jiraSettingsBtn" title="Configure Jira" aria-label="Configure Jira"><i class="icon-settings-2" aria-hidden="true"></i></button>
      </div>
      <div id="jiraFlowHost"></div>

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
        <div class="jira-split">
          <div class="jira-left">
            <div id="jiraTicketDisplay" class="jira-ticket-display" hidden></div>
            <div class="jira-actions-bar" hidden id="jiraActionsBar">
              <button class="jira-btn jira-btn-bug" id="jiraAddBugBtn">&#43; Add Bug</button>
            </div>
            <div id="jiraNotConfigured" class="jira-not-configured" hidden></div>
          </div>
          <div id="jiraBugForm" class="jira-bug-form" hidden>
            <div class="jira-pane-title" id="jiraBugTitle">Report a bug</div>
            <div class="jira-field">
              <label class="jira-label" for="jiraBugSummary">Summary</label>
              <input class="jira-input" id="jiraBugSummary" type="text" placeholder="Bug summary" />
            </div>
            <div class="jira-field">
              <label class="jira-label" for="jiraBugDesc">Steps</label>
              <textarea class="jira-input jira-textarea" id="jiraBugDesc" rows="5" placeholder="Steps to reproduce, expected vs actual…"></textarea>
            </div>
            <div class="jira-field jira-attach-group">
              <span class="jira-label">Attach</span>
              <label class="jira-checkbox-row"><input type="checkbox" id="jiraAttachScreenshot" /> <span class="jira-attach-name">Screenshot</span><span class="jira-count" id="jiraCountShot">1</span></label>
              <label class="jira-checkbox-row">
                <input type="checkbox" id="jiraAttachHar" /> <span class="jira-attach-name">Network log (HAR), last
                <input type="number" id="jiraAttachHarMinutes" class="jira-input jira-minutes-input" min="1" max="120" value="15" /> min</span><span class="jira-count" id="jiraCountHar"></span>
              </label>
              <label class="jira-checkbox-row"><input type="checkbox" id="jiraAttachConsole" /> <span class="jira-attach-name">Console errors</span><span class="jira-count" id="jiraCountConsole"></span></label>
              <label class="jira-checkbox-row"><input type="checkbox" id="jiraAttachSteps" /> <span class="jira-attach-name">Recorded steps</span><span class="jira-count" id="jiraCountSteps"></span></label>
              <div class="jira-attach-warning" id="jiraAttachHarWarning" hidden>HAR may contain cookies and tokens — enable header redaction in Settings to strip them.</div>
            </div>
            <div class="jira-setup-actions">
              <button class="jira-btn jira-btn-primary jira-create" id="jiraSubmitBugBtn">Create bug</button>
              <button class="jira-btn" id="jiraCancelBugBtn">Cancel</button>
              <span class="jira-msg" id="jiraBugMsg"></span>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  loadSettings();

  document.getElementById('jiraSettingsBtn').addEventListener('click', openSettings);
  document.getElementById('jiraSaveSettingsBtn').addEventListener('click', saveSettings);
  document.getElementById('jiraCancelSettingsBtn').addEventListener('click', closeSettings);
  document.getElementById('jiraTokenReplaceBtn').addEventListener('click', () => setTokenEditing(true));
  document.getElementById('jiraFetchBtn').addEventListener('click', fetchTicket);
  /** @type {HTMLInputElement} */ (document.getElementById('jiraTicketKey')).addEventListener('keydown', e => { if (e.key === 'Enter') fetchTicket(); });
  document.getElementById('jiraAddBugBtn').addEventListener('click', openBugForm);
  document.getElementById('jiraCancelBugBtn').addEventListener('click', closeBugForm);
  document.getElementById('jiraSubmitBugBtn').addEventListener('click', submitBug);

  for (const id of ['jiraAttachScreenshot', 'jiraAttachHar', 'jiraAttachHarMinutes', 'jiraAttachConsole', 'jiraAttachSteps']) {
    document.getElementById(id).addEventListener('change', saveAttachPrefs);
  }
}

// #245: the four Attach checkboxes are remembered across bug reports —
// default all on except Steps (a live recording isn't always what the
// tester wants attached, and is often empty).
const ATTACH_PREFS_KEY = 'tb-jira-attach-prefs';

function loadAttachPrefs() {
  try {
    const raw = localStorage.getItem(ATTACH_PREFS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveAttachPrefs() {
  try {
    localStorage.setItem(ATTACH_PREFS_KEY, JSON.stringify({
      screenshot: /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachScreenshot')).checked,
      har: /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachHar')).checked,
      harMinutes: /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachHarMinutes')).value,
      consoleErrors: /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachConsole')).checked,
      steps: /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachSteps')).checked,
    }));
  } catch { /* localStorage unavailable — just don't persist */ }
}

function applyAttachPrefs() {
  const prefs = loadAttachPrefs() || {};
  /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachScreenshot')).checked = prefs.screenshot ?? true;
  /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachHar')).checked = prefs.har ?? true;
  /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachHarMinutes')).value = prefs.harMinutes ?? '15';
  /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachConsole')).checked = prefs.consoleErrors ?? true;
  /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachSteps')).checked = prefs.steps ?? false;
}

function readAttachOptions() {
  const harChecked = /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachHar')).checked;
  let minutes = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('jiraAttachHarMinutes')).value, 10);
  if (!Number.isFinite(minutes)) minutes = 15;
  minutes = Math.min(120, Math.max(1, minutes));
  return {
    screenshot: /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachScreenshot')).checked,
    harMinutes: harChecked ? minutes : null,
    consoleErrors: /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachConsole')).checked,
    steps: /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachSteps')).checked,
  };
}

// The Steps checkbox is disabled (with a title explaining why) when the
// active tab has no current-or-most-recent recording to attach.
async function updateStepsAvailability() {
  const checkbox = /** @type {HTMLInputElement} */ (document.getElementById('jiraAttachSteps'));
  let steps = [];
  try { steps = await testerBrowser.tests.getEvidenceSteps(getActiveId()); } catch { /* treat as unavailable */ }
  const hasSteps = Array.isArray(steps) && steps.length > 0;
  checkbox.disabled = !hasSteps;
  checkbox.title = hasSteps ? '' : 'No recorded steps for this tab yet';
  if (!hasSteps) checkbox.checked = false;
}

// Right-aligned counts next to each attachment: how much evidence is on hand.
async function refreshAttachCounts() {
  let events = [];
  try { events = (await testerBrowser.recording.timeline(getActiveId(), { limit: 5000 })) || []; } catch { /* leave counts blank */ }
  let net = 0, errs = 0;
  for (const e of events) {
    if (e.kind === 'network-request') net++;
    else if (e.kind === 'exception' || (e.kind === 'console' && /error/i.test(e.summary || ''))) errs++;
  }
  document.getElementById('jiraCountHar').textContent = String(net);
  document.getElementById('jiraCountConsole').textContent = String(errs);
  let steps = [];
  try { steps = await testerBrowser.tests.getEvidenceSteps(getActiveId()); } catch { /* none */ }
  document.getElementById('jiraCountSteps').textContent = String(Array.isArray(steps) ? steps.length : 0);
}

async function updateHarRedactionWarning() {
  let settings = {};
  try { settings = await testerBrowser.settings.get(); } catch { /* show the warning by default */ }
  document.getElementById('jiraAttachHarWarning').hidden = !!settings.redactSensitiveHeaders;
}

// #245: mirrors summarizeAttachmentResults() in src/main/jira.ts — the
// renderer has no access to that TS module, so the small formatting logic
// is duplicated here (see CLAUDE.md's note on in-page/cross-runtime pure
// mirror functions), kept in sync by hand.
function summarizeAttachments(results) {
  if (!results || results.length === 0) return '';
  const attached = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  let summary = `attached ${attached}/${results.length}`;
  if (failed.length) summary += ` (${failed.map(f => `${f.filename}: ${f.reason}`).join(', ')})`;
  return summary;
}

async function loadSettings() {
  const s = await testerBrowser.jira.getSettings();
  cachedSettings = s;
  currentHasToken = !!s.hasToken;
  const configured = s.baseUrl && s.email && currentHasToken;
  jiraConfigured = !!configured;
  document.getElementById('jiraNotConfigured').hidden = !!configured;
  document.getElementById('jiraToolbar').classList.toggle('jira-unconfigured', !configured);
  const conn = document.getElementById('jiraConn');
  conn.hidden = !configured;
  document.getElementById('jiraConnHost').textContent = jiraHost(s.baseUrl || '');
  if (!configured) {
    document.getElementById('jiraNotConfigured').replaceChildren(renderEmptyState({
      icon: 'ticket', tone: 'accent', title: 'Connect Jira',
      text: 'Load tickets and file bugs with your session evidence attached.',
      actionLabel: 'Connect Jira', onAction: openSettings,
    }));
  }
  /** @type {HTMLInputElement} */ (document.getElementById('jiraBaseUrl')).value = s.baseUrl || '';
  /** @type {HTMLInputElement} */ (document.getElementById('jiraEmail')).value = s.email || '';
  /** @type {HTMLInputElement} */ (document.getElementById('jiraProjectKey')).value = s.projectKey || '';
  /** @type {HTMLInputElement} */ (document.getElementById('jiraIssueType')).value = s.issueType || 'Bug';
  setTokenEditing(!currentHasToken);
  renderFlow();
}

// Connect → Load ticket or report bug → Attach evidence, derived from state the
// tab already holds. Connect has no button: the "Connect Jira" empty state is
// the single call to action there.
function renderFlow() {
  const host = document.getElementById('jiraFlowHost');
  if (!host) return;
  const bugFormOpen = !document.getElementById('jiraBugForm').hidden;
  const current = jiraFlowStep({ configured: jiraConfigured, bugFormOpen });
  const middle = lastFetchedKey
    ? { actionLabel: 'Report bug', onAction: openBugForm }
    : { actionLabel: 'Load ticket', onAction: () => document.getElementById('jiraTicketKey').focus() };
  host.replaceChildren(renderFlowSteps({
    id: 'jiraFlowSteps',
    label: 'Jira steps',
    current,
    steps: [
      { label: 'Connect' },
      { label: 'Load ticket or report bug', ...middle },
      { label: 'Attach evidence', actionLabel: 'Create bug', onAction: submitBug },
    ],
  }));
}

// A saved token is never sent back to the renderer (#267) — show a "Token
// saved" indicator with a Replace action instead of a password field the
// real value could never actually populate.
function setTokenEditing(editing) {
  document.getElementById('jiraTokenSaved').hidden = editing;
  /** @type {HTMLInputElement} */ (document.getElementById('jiraApiToken')).hidden = !editing;
  if (editing) /** @type {HTMLInputElement} */ (document.getElementById('jiraApiToken')).value = '';
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
  const tokenInput = /** @type {HTMLInputElement} */ (document.getElementById('jiraApiToken'));
  const typedToken = tokenInput.hidden ? '' : tokenInput.value.trim();
  const s = {
    baseUrl: /** @type {HTMLInputElement} */ (document.getElementById('jiraBaseUrl')).value.trim().replace(/\/$/, ''),
    email: /** @type {HTMLInputElement} */ (document.getElementById('jiraEmail')).value.trim(),
    projectKey: /** @type {HTMLInputElement} */ (document.getElementById('jiraProjectKey')).value.trim().toUpperCase(),
    issueType: /** @type {HTMLInputElement} */ (document.getElementById('jiraIssueType')).value.trim() || 'Bug',
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
  await loadSettings();
  setTimeout(closeSettings, 800);
}

async function fetchTicket() {
  const key = /** @type {HTMLInputElement} */ (document.getElementById('jiraTicketKey')).value.trim().toUpperCase();
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
    renderFlow();
    return;
  }

  const f = result.data.fields;
  const summary = f.summary ?? '(no summary)';
  const status = f.status?.name ?? '\u2014';
  const cells = [
    ['Type', f.issuetype?.name ?? '\u2014'],
    ['Priority', f.priority?.name ?? '\u2014'],
    ['Assignee', f.assignee?.displayName ?? 'Unassigned'],
    ['Reporter', f.reporter?.displayName ?? '\u2014'],
    ['Updated', f.updated ? new Date(f.updated).toLocaleDateString() : '\u2014'],
  ];
  const rawDesc = extractText(f.description);
  const desc = rawDesc ? rawDesc.slice(0, 400) + (rawDesc.length > 400 ? '\u2026' : '') : '(no description)';
  const criteria = extractAcceptanceCriteria(f.description);
  const base = (cachedSettings?.baseUrl ?? '').replace(/\/$/, '');

  display.innerHTML = `
    <div class="jira-ticket-card">
      <div class="jira-ticket-head">
        <span class="jira-ticket-key">${escHtml(key)}</span>
        <span class="jira-badge">${escHtml(status)}</span>
        ${base ? `<a href="#" class="jira-open" data-url="${escHtml(base + '/browse/' + key)}">Open in Jira</a>` : ''}
      </div>
      <div class="jira-ticket-summary">${escHtml(summary)}</div>
      <div class="jira-fields">${cells.map(([k, v]) => `<div class="jira-fcell"><div class="jira-flabel">${escHtml(k)}</div><div class="jira-fvalue">${escHtml(String(v))}</div></div>`).join('')}</div>
      <div class="jira-ticket-desc">${escHtml(desc)}</div>
      ${criteria.length ? `<div class="jira-ac"><div class="jira-flabel">Acceptance criteria</div>${criteria.map((c, i) =>
        `<label class="jira-ac-row"><input type="checkbox" id="jiraAc${i}" /> <span>${escHtml(c)}</span></label>`).join('')}</div>` : ''}
    </div>`;
  display.querySelector('.jira-open')?.addEventListener('click', (e) => {
    e.preventDefault();
    testerBrowser.app.openExternal(/** @type {HTMLElement} */ (e.currentTarget).dataset.url);
  });

  lastFetchedKey = key;
  document.getElementById('jiraActionsBar').hidden = false;
  renderFlow();
}

function openBugForm() {
  const form = document.getElementById('jiraBugForm');
  form.hidden = false;
  const currentUrl = /** @type {HTMLInputElement} */ (document.getElementById('urlbar'))?.value ?? '';
  const currentTitle = getTabTitle(getActiveId()) ?? '';
  /** @type {HTMLInputElement} */ (document.getElementById('jiraBugSummary')).value = `Bug in ${currentTitle || currentUrl}`;
  /** @type {HTMLTextAreaElement} */ (document.getElementById('jiraBugDesc')).value =
    `URL: ${currentUrl}\n\nSteps to reproduce:\n1. \n\nExpected:\n\nActual:\n`;
  document.getElementById('jiraBugMsg').textContent = '';
  document.getElementById('jiraBugTitle').textContent = lastFetchedKey ? `Report a bug on ${lastFetchedKey}` : 'Report a bug';
  refreshAttachCounts();
  applyAttachPrefs();
  updateStepsAvailability();
  updateHarRedactionWarning();
  renderFlow();
}

// #306: "Report to Jira" on a Security finding — opens the Jira tab's bug form
// with the summary and description already filled in.
export function openJiraBugFromFinding(summary, description) {
  switchConsoleTab('jira'); // also runs initJira() on the first visit
  openBugForm();
  /** @type {HTMLInputElement} */ (document.getElementById('jiraBugSummary')).value = summary;
  /** @type {HTMLTextAreaElement} */ (document.getElementById('jiraBugDesc')).value = description;
}

function closeBugForm() {
  document.getElementById('jiraBugForm').hidden = true;
  renderFlow();
}

async function submitBug() {
  const summary = /** @type {HTMLInputElement} */ (document.getElementById('jiraBugSummary')).value.trim();
  const desc = /** @type {HTMLTextAreaElement} */ (document.getElementById('jiraBugDesc')).value.trim();
  const msg = document.getElementById('jiraBugMsg');
  if (!summary) {
    msg.textContent = 'Summary is required.';
    msg.className = 'jira-msg jira-msg-error';
    return;
  }
  msg.textContent = 'Creating…';
  msg.className = 'jira-msg';

  const result = await testerBrowser.jira.createIssue(summary, desc, {
    ...(lastFetchedKey ? { linkTo: lastFetchedKey } : {}),
    sessionId: getActiveId(),
    attach: readAttachOptions(),
  });
  if (!result.ok) {
    msg.textContent = `Error: ${result.error}`;
    msg.className = 'jira-msg jira-msg-error';
    return;
  }

  const issueUrl = `${cachedSettings?.baseUrl ?? ''}/browse/${result.key}`;
  const attachSummary = summarizeAttachments(result.attachments);
  const linkNote = result.linkError
    ? ` (could not link to ${escHtml(lastFetchedKey)}: ${escHtml(result.linkError)})`
    : '';
  msg.innerHTML = `Created: <a href="#" id="jiraCreatedLink">${escHtml(result.key)}</a>`
    + `${attachSummary ? ` — ${escHtml(attachSummary)}` : ''}${linkNote}`;
  msg.className = 'jira-msg jira-msg-ok';
  document.getElementById('jiraCreatedLink').addEventListener('click', (e) => {
    e.preventDefault();
    testerBrowser.app.openExternal(issueUrl);
  });
  setTimeout(closeBugForm, 1500);
}

function extractText(node) {
  return adfText(node);
}
