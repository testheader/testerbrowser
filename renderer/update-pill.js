/* global testerBrowser */

// #230: pure, no-DOM helpers — exported for unit testing (see
// src/__tests__/update-pill.test.ts) without booting Electron.

// Only 'downloaded' has something the pill can silently install right now.
// 'available-manual' (found via the release-scan fallback in index.ts) has
// no update info electron-updater could actually download or install, so
// there's nothing for Restart to do — Settings' own "Open release page"
// link is the only action available for that status.
export function shouldShowUpdatePill(status) {
  return status === 'downloaded';
}

export function tempTabCount(sessions) {
  return (sessions || []).filter((s) => !s.persistent).length;
}

function setPopoverOpen(open) {
  document.getElementById('updateReadyPopover').hidden = !open;
}

function isPopoverOpen() {
  return !document.getElementById('updateReadyPopover').hidden;
}

async function restartAndInstall() {
  setPopoverOpen(false);
  await testerBrowser.app.restartAndInstall();
}

async function onPillClick() {
  const sessions = await testerBrowser.sessions.list();
  const n = tempTabCount(sessions);
  if (n === 0) {
    await restartAndInstall();
    return;
  }
  document.getElementById('updateReadyPopoverText').textContent =
    `${n} temporary tab${n === 1 ? '' : 's'} will be closed. Restart now?`;
  setPopoverOpen(true);
}

export function initUpdatePill() {
  const btn = document.getElementById('updateReadyBtn');

  btn.addEventListener('click', onPillClick);
  document.getElementById('updateReadyCancelBtn').addEventListener('click', () => setPopoverOpen(false));
  document.getElementById('updateReadyConfirmBtn').addEventListener('click', restartAndInstall);

  document.addEventListener('click', (e) => {
    if (!isPopoverOpen()) return;
    if (!document.getElementById('updateReadyWrapper').contains(e.target)) setPopoverOpen(false);
  });

  testerBrowser.app.onUpdateStatus(({ status, latest }) => {
    const show = shouldShowUpdatePill(status);
    btn.hidden = !show;
    if (show) {
      btn.textContent = latest ? `Update ${latest} ready — Restart` : 'Update ready — Restart';
    } else {
      setPopoverOpen(false);
    }
  });
}
