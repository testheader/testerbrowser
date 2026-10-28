// #303: the shared empty state — a centred column: icon tile → title → one
// sentence → (optionally) one button. No other explanatory text belongs in a
// panel; the redesign README's "Empty state" pattern.

/**
 * `icon` is a Lucide name without the "icon-" prefix (e.g. 'circle-dot') and
 * `text` is one sentence; `actionLabel`/`onAction` add the optional button.
 * @param {{
 *   icon: string,
 *   tone?: 'neutral' | 'accent' | 'err' | 'warn' | 'ok',
 *   title: string,
 *   text: string,
 *   actionLabel?: string,
 *   actionIcon?: string,
 *   actionTooltip?: string,
 *   onAction?: () => void,
 * }} opts
 * @returns {HTMLElement}
 */
export function renderEmptyState({ icon, tone = 'neutral', title, text, actionLabel, actionIcon, actionTooltip, onAction }) {
  const root = document.createElement('div');
  root.className = 'empty-state';
  root.setAttribute('role', 'status');

  const tile = document.createElement('div');
  tile.className = `empty-state-icon tone-${tone}`;
  const glyph = document.createElement('i');
  glyph.className = `icon-${icon}`;
  glyph.setAttribute('aria-hidden', 'true');
  tile.appendChild(glyph);
  root.appendChild(tile);

  const heading = document.createElement('div');
  heading.className = 'empty-state-title';
  heading.textContent = title;
  root.appendChild(heading);

  const sentence = document.createElement('p');
  sentence.className = 'empty-state-text';
  sentence.textContent = text;
  root.appendChild(sentence);

  if (actionLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `empty-state-btn tone-${tone}`;
    if (actionIcon) {
      // Icon-only button: the label becomes its tooltip and accessible name.
      btn.classList.add('empty-state-btn-icon');
      btn.title = actionTooltip || actionLabel;
      btn.setAttribute('aria-label', actionTooltip || actionLabel);
      const g = document.createElement('i');
      g.className = `icon-${actionIcon}`;
      g.setAttribute('aria-hidden', 'true');
      btn.appendChild(g);
    } else {
      btn.textContent = actionLabel;
    }
    if (onAction) btn.addEventListener('click', onAction);
    root.appendChild(btn);
  }
  return root;
}
