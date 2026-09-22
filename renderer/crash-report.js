/* global testerBrowser */
import { openBugReport } from './bugreport.js';

let pendingCrashLog = null;

export function initCrashReport() {
  document.getElementById('crashReportDismissBtn').onclick = dismissCrash;
  document.getElementById('crashReportFileBtn').onclick = fileIssue;
  checkForCrash();
}

async function checkForCrash() {
  const log = await testerBrowser.crash.check();
  if (!log) return;
  pendingCrashLog = log;
  await showModal(log);
}

// The active tab is a WebContentsView, which paints as a native layer above
// the renderer's own HTML — an HTML modal alone renders underneath it, not
// over it. A crash always leaves a tab view attached (initTabs() runs before
// initCrashReport()'s checkForCrash()), so the modal must hide the view
// first, same as bugreport.js's openBugReport()/replay.js's openReplay().
async function showModal(log) {
  const ts = log.timestamp ? new Date(log.timestamp).toLocaleString() : 'unknown time';
  document.getElementById('crashReportTimestamp').textContent = ts;
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('crashReportOverlay').classList.add('open');
}

async function dismissCrash() {
  document.getElementById('crashReportOverlay').classList.remove('open');
  await testerBrowser.layout.setViewerVisible(true);
  testerBrowser.crash.clear();
  pendingCrashLog = null;
}

async function fileIssue() {
  const log = pendingCrashLog;
  await dismissCrash(); // restores the view; openBugReport() below hides it again itself
  await openBugReport();
  if (log) {
    document.getElementById('bugReportDesc').value = formatCrashForIssue(log);
    document.getElementById('bugReportArea').value = 'Other';
  }
}

function formatCrashForIssue(log) {
  const lines = [
    'TesterBrowser crashed unexpectedly.',
    `Crash time: ${log.timestamp ? new Date(log.timestamp).toLocaleString() : 'unknown'}`,
    '',
  ];
  if (log.sessionUrls?.length) {
    lines.push('**Active tabs at crash time:**');
    for (const url of log.sessionUrls) lines.push(`- ${url}`);
    lines.push('');
  }
  if (log.recentErrors?.length) {
    lines.push('**Recent errors before crash:**');
    for (const e of log.recentErrors) {
      lines.push(`- [${new Date(e.ts).toLocaleTimeString()}] ${e.message}`);
    }
    lines.push('');
  }
  lines.push('**Steps to reproduce:**');
  lines.push('<!-- Please describe what you were doing when TesterBrowser crashed. -->');
  return lines.join('\n');
}
