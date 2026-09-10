/* global testerBrowser */
import { applyTheme, getStoredScheme } from './theme.js';

const STATUS_CONFIG = {
  checking:        { cls: 'info', text: 'Checking for updates…' },
  available:       { cls: 'info', text: (v) => `Update ${v} found — downloading…` },
  downloading:     { cls: 'info', text: 'Downloading update…' },
  downloaded:      { cls: 'warn', text: (v) => `Update ${v} downloaded — restart to install` },
  'not-available': { cls: 'ok',   text: 'You\'re up to date' },
  error:           { cls: 'err',  text: (msg) => `Update error: ${msg || 'unknown'}` },
};

function applyUpdateStatus({ status, current, latest }) {
  document.getElementById('currentVersion').textContent = current || '—';
  document.getElementById('latestVersion').textContent  = latest || (status === 'not-available' ? current : '—');
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.checking;
  const el  = document.getElementById('updateStatusText');
  el.className   = cfg.cls;
  el.textContent = typeof cfg.text === 'function' ? cfg.text(latest) : cfg.text;
  document.getElementById('restartBtn').style.display      = status === 'downloaded' ? '' : 'none';
  document.getElementById('copyUpdateLogBtn').style.display = status === 'error'     ? '' : 'none';
}

export async function openSettings() {
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('settingsOverlay').classList.add('open');
  applyUpdateStatus(await testerBrowser.app.getVersionInfo());
  const settings = await testerBrowser.settings.get();
  document.getElementById('redactHeadersToggle').checked = !!settings.redactSensitiveHeaders;
  document.getElementById('searchEngineSelect').value = settings.searchEngine || 'google';

  document.getElementById('themeSelect').value = getStoredScheme();

  await refreshGithubAuthStatus();
}

async function refreshGithubAuthStatus() {
  const hasToken = await testerBrowser.bugReport.hasToken();
  const status = document.getElementById('githubTokenStatus');
  status.textContent = hasToken ? 'Signed in ✓' : 'Not signed in';
  status.style.color = hasToken ? 'var(--ok,#4caf50)' : '';
  document.getElementById('githubSignInBtn').hidden = hasToken;
  document.getElementById('githubSignOutBtn').hidden = !hasToken;
  document.getElementById('githubOAuthPending').hidden = true;
}

function switchSettingsTab(pane) {
  document.querySelectorAll('.settings-nav-btn').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.pane === pane)
  );
  document.querySelectorAll('.settings-pane').forEach((el) =>
    el.classList.toggle('active', el.dataset.pane === pane)
  );
}

function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('open');
  testerBrowser.layout.setViewerVisible(true);
}

export function initSettings() {
  document.querySelectorAll('.settings-nav-btn').forEach((btn) =>
    btn.addEventListener('click', () => switchSettingsTab(btn.dataset.pane))
  );

  document.getElementById('closeSettingsBtn').onclick  = closeSettings;
  document.getElementById('settingsCloseXBtn').onclick = closeSettings;
  document.getElementById('settingsOverlay').onclick   = (e) => {
    if (e.target === document.getElementById('settingsOverlay')) closeSettings();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('settingsOverlay').classList.contains('open')) closeSettings();
  });
  document.getElementById('checkUpdatesBtn').onclick   = async () => {
    document.getElementById('updateStatusText').className   = 'info';
    document.getElementById('updateStatusText').textContent = 'Checking for updates…';
    document.getElementById('latestVersion').textContent    = '—';
    await testerBrowser.app.checkForUpdates();
  };
  document.getElementById('restartBtn').onclick = () => testerBrowser.app.restartAndInstall();

  document.getElementById('copyUpdateLogBtn').onclick = async () => {
    const entries = await testerBrowser.app.getUpdateLog();
    const text = entries.length
      ? entries.map(e => `[${e.timestamp}] ${e.status}: ${e.message} (current=${e.currentVersion}, latest=${e.latestVersion ?? 'unknown'})`).join('\n')
      : 'No update error log entries found.';
    await testerBrowser.clipboard.write(text);
    const btn = document.getElementById('copyUpdateLogBtn');
    const prev = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  };

  document.getElementById('redactHeadersToggle').addEventListener('change', (e) => {
    testerBrowser.settings.set({ redactSensitiveHeaders: e.target.checked });
  });

  document.getElementById('searchEngineSelect').addEventListener('change', (e) => {
    testerBrowser.settings.set({ searchEngine: e.target.value });
  });

  document.getElementById('themeSelect').addEventListener('change', (e) => {
    applyTheme(e.target.value);
  });

  document.getElementById('githubSignInBtn').onclick = async () => {
    const status = document.getElementById('githubTokenStatus');
    document.getElementById('githubSignInBtn').hidden = true;
    status.textContent = '';
    const result = await testerBrowser.bugReport.startOAuth();
    if (!result.ok) {
      status.textContent = result.error || 'Failed to start sign-in';
      status.style.color = 'var(--err,#f44336)';
      document.getElementById('githubSignInBtn').hidden = false;
      return;
    }
    document.getElementById('githubUserCode').textContent = result.user_code;
    document.getElementById('githubOAuthPending').hidden = false;
  };

  document.getElementById('githubSignOutBtn').onclick = async () => {
    await testerBrowser.bugReport.signOut();
    await refreshGithubAuthStatus();
  };

  testerBrowser.bugReport.onOAuthDone(async ({ ok, error }) => {
    if (ok) {
      await refreshGithubAuthStatus();
    } else {
      const status = document.getElementById('githubTokenStatus');
      status.textContent = error === 'access_denied' ? 'Sign-in cancelled.' : 'Sign-in expired — try again.';
      status.style.color = 'var(--err,#f44336)';
      document.getElementById('githubOAuthPending').hidden = true;
      document.getElementById('githubSignInBtn').hidden = false;
    }
  });

  testerBrowser.app.onShowSettings(() => openSettings());
  testerBrowser.app.onUpdateStatus((data) => applyUpdateStatus(data));
}
