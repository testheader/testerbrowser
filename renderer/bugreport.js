/* global testerBrowser */
import { state } from './state.js';

let screenshotB64 = null;

const AREA_BY_CONSOLE_TAB = {
  console: 'Console / Network', network: 'Console / Network', storage: 'Storage',
  a11y: 'A11y', diff: 'Diff', vr: 'Visual Regression', spoof: 'Spoof',
  security: 'Security', mock: 'Mock', resilience: 'Resilience', jira: 'Jira', tests: 'Tests',
};

async function openBugReport() {
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('bugReportOverlay').classList.add('open');
  resetForm();
  document.getElementById('bugReportArea').value = AREA_BY_CONSOLE_TAB[state.activeConsoleTab] || 'Other';

  const diag = await testerBrowser.bugReport.getDiagnostics();
  document.getElementById('bugReportDiagPreview').textContent = formatDiagnostics(diag);

  screenshotB64 = await testerBrowser.bugReport.captureScreenshot();
  const img = document.getElementById('bugReportShotPreview');
  if (screenshotB64) img.src = `data:image/png;base64,${screenshotB64}`;
  else img.removeAttribute('src');
}

function formatDiagnostics(d) {
  const lines = [
    `TesterBrowser ${d.version}`,
    `Electron ${d.electron}  Chrome ${d.chrome}  Node ${d.node}`,
    `${d.platform} ${d.arch} (${d.osRelease})`,
  ];
  if (d.recentErrors?.length) {
    lines.push('', 'Recent app errors:');
    for (const e of d.recentErrors) lines.push(`[${new Date(e.ts).toLocaleTimeString()}] ${e.message}`);
  } else {
    lines.push('', 'No recent app errors recorded.');
  }
  return lines.join('\n');
}

function resetForm() {
  document.getElementById('bugReportFormView').hidden = false;
  document.getElementById('bugReportConfirmView').hidden = true;
  document.getElementById('bugReportSubmitBtn').hidden = false;
  document.getElementById('bugReportDoneBtn').hidden = true;
  document.getElementById('bugReportDesc').value = '';
  const msg = document.getElementById('bugReportMsg');
  msg.textContent = '';
  msg.className = '';
}

function closeBugReport() {
  document.getElementById('bugReportOverlay').classList.remove('open');
  testerBrowser.layout.setViewerVisible(true);
}

async function submitBugReport() {
  const area = document.getElementById('bugReportArea').value;
  const description = document.getElementById('bugReportDesc').value.trim();
  const msg = document.getElementById('bugReportMsg');
  if (!description) {
    msg.textContent = 'Please describe what happened.';
    msg.className = 'err';
    return;
  }
  const btn = document.getElementById('bugReportSubmitBtn');
  btn.disabled = true;
  msg.textContent = 'Submitting…';
  msg.className = '';

  const result = await testerBrowser.bugReport.submit({ area, description, screenshotB64 });
  btn.disabled = false;

  if (!result.ok) {
    msg.textContent = result.error || 'Failed to submit bug report.';
    msg.className = 'err';
    return;
  }

  document.getElementById('bugReportFormView').hidden = true;
  document.getElementById('bugReportConfirmView').hidden = false;
  document.getElementById('bugReportConfirmText').textContent =
    `Issue #${result.number} created` + (result.boardAdded ? ' and added to the project board.' : ' — could not confirm the project board add, check it manually.');
  const link = document.getElementById('bugReportLink');
  link.dataset.url = result.url;
  document.getElementById('bugReportSubmitBtn').hidden = true;
  document.getElementById('bugReportDoneBtn').hidden = false;
}

export function initBugReport() {
  document.getElementById('bugReportCancelBtn').onclick = closeBugReport;
  document.getElementById('bugReportDoneBtn').onclick = closeBugReport;
  document.getElementById('bugReportOverlay').onclick = (e) => {
    if (e.target === document.getElementById('bugReportOverlay')) closeBugReport();
  };
  document.getElementById('bugReportSubmitBtn').onclick = submitBugReport;
  document.getElementById('bugReportLink').onclick = (e) => {
    e.preventDefault();
    const url = e.currentTarget.dataset.url;
    if (url) testerBrowser.app.openExternal(url);
  };

  testerBrowser.bugReport.onShow(() => openBugReport());
}
