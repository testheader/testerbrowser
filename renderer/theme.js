/* global testerBrowser */

const LS_KEY = 'colorScheme';

function applyTheme(scheme) {
  if (scheme === 'light') {
    document.body.classList.add('light-mode');
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.title = 'Switch to dark mode';
  } else {
    document.body.classList.remove('light-mode');
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.title = 'Switch to light mode';
  }
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
