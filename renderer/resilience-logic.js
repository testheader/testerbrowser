// Pure helpers behind the Resilience add-rule stepper (#353) — no DOM, so the
// step validation and the summary line are unit-testable.

export const RES_STEP_COUNT = 3;

// Race gate bounds — mirror src/main/raceGate.ts (the renderer is unbundled
// ESM and can't import it). The main process re-clamps, so these only drive
// validation and defaults in the form.
export const RACE_MIN_COUNT = 2;
export const RACE_MAX_COUNT = 50;
export const RACE_DEFAULT_TIMEOUT_SEC = 10;
export const RACE_MAX_TIMEOUT_SEC = 120;

/**
 * Whether the user may leave `step` (1-based) going forward.
 * @param {number} step
 * @param {{ urlPattern: string, probability: string | number, type?: string, holdCount?: string | number, timeoutSec?: string | number }} v
 */
export function isResStepValid(step, v) {
  if (step === 2) return String(v.urlPattern ?? '').trim().length > 0;
  if (step === 3) {
    if (v.type === 'race') {
      const n = Number(v.holdCount);
      const t = Number(v.timeoutSec);
      return Number.isInteger(n) && n >= RACE_MIN_COUNT && n <= RACE_MAX_COUNT
        && Number.isInteger(t) && t >= 1 && t <= RACE_MAX_TIMEOUT_SEC;
    }
    const p = Number(v.probability);
    return Number.isInteger(p) && p >= 1 && p <= 100;
  }
  return true;
}

/**
 * One-line description of the rule being built, e.g. "500 error on `*ads*`, 100%".
 * @param {{ typeLabel: string, urlPattern: string, method?: string | null, probability: string | number,
 *           latencyMs?: number | null, releaseSec?: number | null, type?: string,
 *           holdCount?: number | null }} v
 */
export function summarizeResRule(v) {
  const url = String(v.urlPattern ?? '').trim() || '*';
  const method = v.method && v.method !== '*' ? `${v.method} ` : '';
  if (v.type === 'race') {
    const n = v.holdCount || RACE_MIN_COUNT;
    return `${v.typeLabel} on ${method}\`${url}\`: holds ${n} requests, releases them together (or after ${v.releaseSec || RACE_DEFAULT_TIMEOUT_SEC} s)`;
  }
  let s = `${v.typeLabel} on ${method}\`${url}\`, ${v.probability}%`;
  if ((v.type === 'latency' || v.type === 'stall504') && v.latencyMs) s += `, ${v.latencyMs} ms`;
  if (v.type === 'hang' && v.releaseSec) s += `, released after ${v.releaseSec} s`;
  return s;
}
