/* global testerBrowser */

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

const THEME_LS_KEY = 'colorScheme';

function applyThemeFromSelect(scheme) {
  if (scheme === 'light') {
    document.body.classList.add('light-mode');
  } else if (scheme === 'dark') {
    document.body.classList.remove('light-mode');
  } else {
    // system
    const preferLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    document.body.classList.toggle('light-mode', preferLight);
  }
  const toggleBtn = document.getElementById('themeToggleBtn');
  if (toggleBtn) {
    toggleBtn.title = document.body.classList.contains('light-mode')
      ? 'Switch to dark mode'
      : 'Switch to light mode';
  }
}

async function openSettings() {
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('settingsOverlay').classList.add('open');
  applyUpdateStatus(await testerBrowser.app.getVersionInfo());
  const settings = await testerBrowser.settings.get();
  document.getElementById('redactHeadersToggle').checked = !!settings.redactSensitiveHeaders;

  let stored;
  try { stored = localStorage.getItem(THEME_LS_KEY); } catch {}
  document.getElementById('themeSelect').value = stored || 'system';

  await refreshGithubTokenStatus();
}

async function refreshGithubTokenStatus() {
  const hasToken = await testerBrowser.bugReport.hasToken();
  document.getElementById('githubTokenStatus').textContent = hasToken ? 'Configured ✓' : 'Not configured';
}

function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('open');
  testerBrowser.layout.setViewerVisible(true);
}

export function initSettings() {
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

  document.getElementById('themeSelect').addEventListener('change', (e) => {
    const scheme = e.target.value;
    try { localStorage.setItem(THEME_LS_KEY, scheme); } catch {}
    applyThemeFromSelect(scheme);
  });

  document.getElementById('githubTokenSaveBtn').onclick = async () => {
    const input = document.getElementById('githubTokenInput');
    const status = document.getElementById('githubTokenStatus');
    const result = await testerBrowser.bugReport.saveToken(input.value);
    input.value = '';
    if (!result.ok) {
      status.textContent = result.error || 'Failed to save token';
      return;
    }
    await refreshGithubTokenStatus();
  };

  testerBrowser.app.onShowSettings(() => openSettings());
  testerBrowser.app.onUpdateStatus((data) => applyUpdateStatus(data));
}
