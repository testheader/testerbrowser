/* global testerBrowser */
import { state } from './state.js';

let screenshotB64 = null;

const AREA_BY_CONSOLE_TAB = {
  console: 'Console / Network', network: 'Console / Network', storage: 'Storage',
  a11y: 'A11y', diff: 'Network diff', vr: 'UI diff', spoof: 'Spoof',
  security: 'Security', mock: 'Mock', resilience: 'Resilience', jira: 'Jira', tests: 'Record Playback',
  follow: 'Follow Along',
};

export async function openBugReport() {
  // Capture the app's current state before the modal ever appears — capturing
  // after showing it means the screenshot mostly just shows the report form.
  const captured = await testerBrowser.bugReport.captureScreenshot();
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('bugReportOverlay').classList.add('open');
  resetForm();
  document.getElementById('bugReportArea').value = AREA_BY_CONSOLE_TAB[state.activeConsoleTab] || 'Other';
  setScreenshot(captured);

  const diag = await testerBrowser.bugReport.getDiagnostics();
  document.getElementById('bugReportDiagPreview').value = formatDiagnostics(diag);
}

function setScreenshot(b64) {
  screenshotB64 = b64 || null;
  const img = document.getElementById('bugReportShotPreview');
  if (screenshotB64) img.src = `data:image/jpeg;base64,${screenshotB64}`;
  else img.removeAttribute('src');
}

async function retakeScreenshot() {
  const btn = document.getElementById('bugReportRetakeBtn');
  btn.disabled = true;
  document.getElementById('bugReportOverlay').classList.remove('open');
  await testerBrowser.layout.setViewerVisible(true);
  // capturePage() reads whatever is currently composited, so wait a couple of
  // frames for the window to actually repaint with the modal hidden first.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const captured = await testerBrowser.bugReport.captureScreenshot();
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('bugReportOverlay').classList.add('open');
  setScreenshot(captured);
  btn.disabled = false;
}

function uploadScreenshot(file) {
  const reader = new FileReader();
  reader.onload = () => {
    // Normalize to JPEG so it matches what capture already produces (the
    // preview's data URI and the .jpg filename the backend attaches under).
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      setScreenshot(canvas.toDataURL('image/jpeg', 0.85).split(',')[1] || '');
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
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
  const diagnostics = document.getElementById('bugReportDiagPreview').value;
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

  const result = await testerBrowser.bugReport.submit({ area, description, diagnostics, screenshotB64 });
  btn.disabled = false;

  if (!result.ok) {
    msg.textContent = result.error || 'Failed to submit bug report.';
    msg.className = 'err';
    return;
  }

  document.getElementById('bugReportFormView').hidden = true;
  document.getElementById('bugReportConfirmView').hidden = false;
  let text = `Issue #${result.number} created` + (result.boardAdded ? ' and added to the project board.' : ' — could not confirm the project board add, check it manually.');
  if (screenshotB64) {
    text += result.screenshotAttached
      ? ' Screenshot attached.'
      : ` Screenshot could not be attached${result.screenshotError ? ` (${result.screenshotError})` : ''} — you can add it manually.`;
  }
  document.getElementById('bugReportConfirmText').textContent = text;
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
  document.getElementById('bugReportRetakeBtn').onclick = retakeScreenshot;
  document.getElementById('bugReportUploadBtn').onclick = () => document.getElementById('bugReportShotFile').click();
  document.getElementById('bugReportShotFile').onchange = (e) => {
    const file = e.target.files[0];
    if (file) uploadScreenshot(file);
    e.target.value = '';
  };
  document.getElementById('bugReportLink').onclick = (e) => {
    e.preventDefault();
    const url = e.currentTarget.dataset.url;
    if (url) testerBrowser.app.openExternal(url);
  };

  testerBrowser.bugReport.onShow(() => openBugReport());
}
