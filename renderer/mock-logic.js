// Pure helpers behind the Mock add-rule stepper (#355) — no DOM, so the step
// validation and the summary line are unit-testable.

export const MOCK_STEP_COUNT = 2;

/**
 * Whether the user may leave `step` (1-based) going forward / submit from it.
 * Step 1 needs a URL pattern; step 2 needs a status code of 100–599.
 * @param {number} step
 * @param {{ urlPattern: string, status: string | number }} v
 */
export function isMockStepValid(step, v) {
  if (step === 1) return String(v.urlPattern ?? '').trim().length > 0;
  if (step === 2) {
    const s = Number(v.status);
    return String(v.status ?? '').trim() !== '' && Number.isInteger(s) && s >= 100 && s <= 599;
  }
  return true;
}

/**
 * One-line description of the rule being built, e.g. "200 on GET https://api.example.com/*".
 * @param {{ status: string | number, method?: string | null, urlPattern: string }} v
 */
export function summarizeMockRule(v) {
  const method = v.method && v.method !== '*' ? `${v.method} ` : '';
  const url = String(v.urlPattern ?? '').trim() || '*';
  return `${v.status} on ${method}${url}`;
}
