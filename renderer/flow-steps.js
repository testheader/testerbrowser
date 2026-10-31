// A compact, state-driven stepper for multi-step features (UI diff capture →
// compare, Record → Assert → Save → Run, …). It carries no explanatory text:
// short step labels, a tick on finished steps, and one call-to-action button
// on the current step that delegates to the feature's existing handler. The
// feature recomputes `current` (see flow-logic.js) and re-renders, so there is
// nothing to dismiss or persist.

/**
 * @typedef {{ label: string, actionLabel?: string, actionTitle?: string, actionDisabled?: boolean, onAction?: () => void }} FlowStep
 */

/**
 * `current` is the index of the active step; earlier steps are done, later ones
 * todo. Only the active step shows its button. Pass `current >= steps.length`
 * for a finished flow (every step ticked).
 * @param {{ steps: FlowStep[], current: number, id?: string, label?: string }} opts
 * @returns {HTMLElement}
 */
export function renderFlowSteps({ steps, current, id, label = 'Steps' }) {
  const root = document.createElement('ol');
  root.className = 'flow-steps';
  if (id) root.id = id;
  root.setAttribute('aria-label', label);

  steps.forEach((step, i) => {
    const state = i < current ? 'done' : i === current ? 'current' : 'todo';
    const li = document.createElement('li');
    li.className = `flow-step ${state}`;
    if (state === 'current') li.setAttribute('aria-current', 'step');

    const num = document.createElement('span');
    num.className = 'flow-step-num';
    num.setAttribute('aria-hidden', 'true');
    num.textContent = state === 'done' ? '✓' : String(i + 1);

    const text = document.createElement('span');
    text.className = 'flow-step-label';
    text.textContent = step.label;

    li.append(num, text);

    if (state === 'current' && step.actionLabel && step.onAction) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'flow-step-btn';
      btn.textContent = step.actionLabel;
      if (step.actionTitle) btn.title = step.actionTitle;
      if (step.actionDisabled) btn.disabled = true;
      btn.addEventListener('click', step.onAction);
      li.appendChild(btn);
    }
    root.appendChild(li);
  });
  return root;
}
