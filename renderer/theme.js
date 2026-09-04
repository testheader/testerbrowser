/* global testerBrowser */

const LS_KEY = 'colorScheme';
const VALID_SCHEMES = new Set(['light', 'dark', 'system']);

// Single source of truth for the app's color scheme — both the titlebar
// toggle and the Settings "Theme" dropdown read/write through here so they
// always agree on what's currently selected and what it resolves to.
export function getStoredScheme() {
  let scheme;
  try { scheme = localStorage.getItem(LS_KEY); } catch {}
  return VALID_SCHEMES.has(scheme) ? scheme : 'system';
}

function resolveLight(scheme) {
  if (scheme === 'light') return true;
  if (scheme === 'dark') return false;
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}

export function applyTheme(scheme) {
  if (!VALID_SCHEMES.has(scheme)) scheme = 'system';
  try { localStorage.setItem(LS_KEY, scheme); } catch {}

  const light = resolveLight(scheme);
  document.body.classList.toggle('light-mode', light);

  const btn = document.getElementById('themeToggleBtn');
  if (btn) {
    const nextScheme = scheme === 'light' ? 'dark' : scheme === 'dark' ? 'system' : 'light';
    btn.title = scheme === 'system'
      ? `Following system theme (currently ${light ? 'light' : 'dark'}) — click to switch to ${nextScheme} mode`
      : `Switch to ${nextScheme} mode`;
    // Icon shows the resolved theme; a dot marks "system" so the toggle can
    // represent all three states instead of forcing a concrete choice.
    btn.textContent = light ? '☽' : '☀';
    btn.classList.toggle('theme-system', scheme === 'system');
  }

  const select = document.getElementById('themeSelect');
  if (select && select.value !== scheme) select.value = scheme;

  // Session views render their own pages (newtab) and need to be told.
  testerBrowser.theme.set(light ? 'light' : 'dark');
}

export function initTheme() {
  applyTheme(getStoredScheme());

  document.getElementById('themeToggleBtn').addEventListener('click', () => {
    const current = getStoredScheme();
    const next = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
    applyTheme(next);
  });

  // Live-follow OS theme changes while "system" is selected, instead of only
  // resolving it once at startup and then ignoring further OS changes.
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getStoredScheme() === 'system') applyTheme('system');
  });

  document.getElementById('winMinBtn').addEventListener('click', () => testerBrowser.windowControls.minimize());
  document.getElementById('winMaxBtn').addEventListener('click', () => testerBrowser.windowControls.maximize());
  document.getElementById('winCloseBtn').addEventListener('click', () => testerBrowser.windowControls.close());

  applyMaximizedState(false);
  testerBrowser.windowControls.isMaximized().then(applyMaximizedState).catch(() => {});
  testerBrowser.windowControls.onMaximizedChanged(applyMaximizedState);
}

function applyMaximizedState(maximized) {
  const btn = document.getElementById('winMaxBtn');
  if (!btn) return;
  btn.title = maximized ? 'Restore' : 'Maximize';
  document.getElementById('winMaxIcon').hidden = maximized;
  document.getElementById('winRestoreIcon').hidden = !maximized;
}
