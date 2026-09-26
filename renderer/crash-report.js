/* global testerBrowser */
import { openBugReport } from './bugreport.js';
import { formatAppLogBlock, redactUrlForReport } from './utils.js';
import { openModal, closeModal } from './modal.js';

let pendingCrashLog = null;

export function initCrashReport() {
  document.getElementById('crashReportDismissBtn').onclick = dismissCrash;
  document.getElementById('crashReportFileBtn').onclick = fileIssue;
  document.getElementById('crashReportLogFolderBtn').onclick = () => testerBrowser.appLog.revealFolder();
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
  // crashedAt (#226) is when the crash was actually detected on this later
  // launch — log.timestamp is the crashed session's own *start* time, which
  // older crash logs (written before crashedAt existed) fall back to.
  const detectedAt = log.crashedAt ?? log.timestamp;
  const ts = detectedAt ? new Date(detectedAt).toLocaleString() : 'unknown time';
  document.getElementById('crashReportTimestamp').textContent = ts;
  document.getElementById('crashReportFullUrls').checked = false;
  await openModal('crashReportOverlay');
}

async function dismissCrash() {
  await closeModal('crashReportOverlay');
  testerBrowser.crash.clear();
  pendingCrashLog = null;
}

async function fileIssue() {
  const log = pendingCrashLog;
  // Read before dismissCrash() below, which hides/resets the crash overlay.
  const fullUrls = document.getElementById('crashReportFullUrls').checked;
  await dismissCrash(); // restores the view; openBugReport() below hides it again itself
  await openBugReport();
  if (log) {
    document.getElementById('bugReportDesc').value = formatCrashForIssue(log, { fullUrls });
    document.getElementById('bugReportArea').value = 'Other';
  }
}

function formatCrashForIssue(log, { fullUrls = false } = {}) {
  const detectedAt = log.crashedAt ?? log.timestamp;
  const lines = [
    'TesterBrowser crashed unexpectedly.',
    `Crash time: ${detectedAt ? new Date(detectedAt).toLocaleString() : 'unknown'}`,
    `Session started: ${log.timestamp ? new Date(log.timestamp).toLocaleString() : 'unknown'}`,
    '',
  ];
  if (log.sessionUrls?.length) {
    lines.push('**Active tabs at crash time:**');
    for (const url of log.sessionUrls) lines.push(`- ${fullUrls ? url : redactUrlForReport(url)}`);
    lines.push('');
  }
  if (log.recentErrors?.length) {
    lines.push('**Recent errors before crash:**');
    for (const e of log.recentErrors) {
      lines.push(`- [${new Date(e.ts).toLocaleTimeString()}] ${e.message}`);
    }
    lines.push('');
  }
  if (log.logTail?.length) {
    lines.push(formatAppLogBlock({ text: log.logTail.join('\n'), truncated: !!log.logTailTruncated }));
    lines.push('');
  }
  lines.push('**Steps to reproduce:**');
  lines.push('<!-- Please describe what you were doing when TesterBrowser crashed. -->');
  return lines.join('\n');
}
