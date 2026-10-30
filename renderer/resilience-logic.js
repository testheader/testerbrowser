// Pure helpers behind the Resilience add-rule stepper (#353) — no DOM, so the
// step validation and the summary line are unit-testable.

export const RES_STEP_COUNT = 3;

/**
 * Whether the user may leave `step` (1-based) going forward.
 * @param {number} step
 * @param {{ urlPattern: string, probability: string | number }} v
 */
export function isResStepValid(step, v) {
  if (step === 2) return String(v.urlPattern ?? '').trim().length > 0;
  if (step === 3) {
    const p = Number(v.probability);
    return Number.isInteger(p) && p >= 1 && p <= 100;
  }
  return true;
}

/**
 * One-line description of the rule being built, e.g. "500 error on `*ads*`, 100%".
 * @param {{ typeLabel: string, urlPattern: string, method?: string | null, probability: string | number,
 *           latencyMs?: number | null, releaseSec?: number | null, type?: string }} v
 */
export function summarizeResRule(v) {
  const url = String(v.urlPattern ?? '').trim() || '*';
  const method = v.method && v.method !== '*' ? `${v.method} ` : '';
  let s = `${v.typeLabel} on ${method}\`${url}\`, ${v.probability}%`;
  if ((v.type === 'latency' || v.type === 'stall504') && v.latencyMs) s += `, ${v.latencyMs} ms`;
  if (v.type === 'hang' && v.releaseSec) s += `, released after ${v.releaseSec} s`;
  return s;
}
