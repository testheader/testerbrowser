// #298: small count pills on the Console, A11y and Security tool tabs, so
// errors and findings are visible without opening the tab.
const BADGES = {
  console:  { id: 'consoleTabConsole',  tone: 'err',  noun: 'error' },
  a11y:     { id: 'consoleTabA11y',     tone: 'warn', noun: 'issue' },
  security: { id: 'consoleTabSecurity', tone: 'warn', noun: 'finding' },
};

// Pure — the accessible label for a badge, e.g. "2 errors" / "1 issue".
export function badgeLabel(tab, count) {
  const noun = BADGES[tab].noun;
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// Shows `count` on the given tab (console | a11y | security), or hides the
// badge at 0 / when not a positive number.
export function setTabBadge(tab, count) {
  const cfg = BADGES[tab];
  const btn = document.getElementById(cfg.id);
  if (!btn) return;
  let badge = btn.querySelector('.tab-badge');
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (n === 0) { badge?.remove(); return; }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = `tab-badge tab-badge-${cfg.tone}`;
    badge.setAttribute('role', 'img');
    btn.appendChild(badge);
  }
  const text = n > 99 ? '99+' : String(n);
  if (badge.textContent !== text) badge.textContent = text;
  badge.setAttribute('aria-label', badgeLabel(tab, n));
}
