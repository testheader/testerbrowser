/* global testerBrowser */

const LS_KEY = 'colorScheme';

function applyTheme(scheme) {
  const light = scheme === 'light';
  document.body.classList.toggle('light-mode', light);
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.title = light ? 'Switch to dark mode' : 'Switch to light mode';
  // Session views render their own pages (newtab) and need to be told.
  testerBrowser.theme.set(light ? 'light' : 'dark');
}

export function initTheme() {
  let scheme;
  try { scheme = localStorage.getItem(LS_KEY); } catch {}
  if (!scheme) {
    scheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  applyTheme(scheme);

  document.getElementById('themeToggleBtn').addEventListener('click', () => {
    const current = document.body.classList.contains('light-mode') ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(LS_KEY, next); } catch {}
    applyTheme(next);
  });

  document.getElementById('winMinBtn').addEventListener('click', () => testerBrowser.windowControls.minimize());
  document.getElementById('winMaxBtn').addEventListener('click', () => testerBrowser.windowControls.maximize());
  document.getElementById('winCloseBtn').addEventListener('click', () => testerBrowser.windowControls.close());
}
