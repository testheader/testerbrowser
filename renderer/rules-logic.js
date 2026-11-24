// Pure helpers behind the Rules add/edit stepper (#370) — no DOM, so step
// validation, building a rule from the form's values and the summary lines
// are unit-testable.
//
// The form is three steps, and a rule with nothing left to configure skips the
// last one:
//   1. Match   — method, URL pattern, how often (probability)
//   2. Action  — what to do, plus that action's own small settings
//   3. Details — the mock response, or what a rewrite changes

/** @typedef {'mock'|'fail'|'delay'|'hang'|'race'|'rewrite'} RuleKind */

/**
 * @typedef {Object} RuleFields  the form's values, already read out of the DOM
 * @property {string} method
 * @property {string} urlPattern
 * @property {string|number} probability   percent, 1–100
 * @property {RuleKind} kind
 * @property {string} failMode
 * @property {string|number} delayMs
 * @property {string|number} hangFailAfterSec
 * @property {string|number} raceBatch
 * @property {string|number} raceGiveUpSec
 * @property {string|number} mockStatus
 * @property {string} mockBody
 * @property {Record<string,string>} mockHeaders
 * @property {boolean} mockCors
 * @property {string} rwUrl
 * @property {string} rwMethod
 * @property {Record<string,string>} rwHeaders
 * @property {boolean} rwBodyOn
 * @property {string} rwBody
 * @property {boolean} cookiesOn
 * @property {string} cookieSource        partition of the session to read cookies from ('' = none)
 * @property {Record<string,string>} cookieExtra
 */

// Mirrors src/main/raceGate.ts and rules.ts (the renderer is unbundled ESM and
// can't import them). The main process re-clamps; these drive validation only.
export const RACE_MIN_COUNT = 2;
export const RACE_MAX_COUNT = 50;
export const RACE_DEFAULT_GIVE_UP_SEC = 10;
export const RACE_MAX_GIVE_UP_SEC = 120;
export const HANG_MAX_FAIL_AFTER_SEC = 600;
export const MAX_DELAY_MS = 120000;

/** @type {{ kind: RuleKind, label: string, icon: string, desc: string }[]} */
export const ACTIONS = [
  { kind: 'mock',    label: 'Mock',    icon: 'replace',      desc: 'Answer with a response you write. The request never reaches the server.' },
  { kind: 'fail',    label: 'Fail',    icon: 'server-crash', desc: 'Break the request: an error status, offline, or a garbled body.' },
  { kind: 'delay',   label: 'Delay',   icon: 'timer',        desc: 'Hold the request for a while, then let it through unchanged.' },
  { kind: 'hang',    label: 'Hang',    icon: 'pause',        desc: 'Never answer. The request stays pending until the page gives up or navigates away.' },
  { kind: 'race',    label: 'Race',    icon: 'git-merge',    desc: 'Hold matching requests until enough have arrived, then send them all at once. Trigger the same action in several tabs, or double-click, to probe for race conditions.' },
  { kind: 'rewrite', label: 'Rewrite', icon: 'pencil',       desc: 'Change what is sent to the server: URL, method, headers, body and cookies. The real response comes back.' },
];

export const FAIL_MODES = [
  { value: 'error500', label: '500 Internal Server Error' },
  { value: 'timeout',  label: '504 Gateway Timeout' },
  { value: 'missing',  label: '404 Not Found' },
  { value: 'offline',  label: 'Offline (connection fails)' },
  { value: 'corrupt',  label: '200 with a garbled body' },
];

/** Kinds that have a third step (the mock response / what a rewrite changes). */
export function hasDetailsStep(kind) {
  return kind === 'mock' || kind === 'rewrite';
}

/** @param {RuleKind} kind */
export function stepCount(kind) {
  return hasDetailsStep(kind) ? 3 : 2;
}

/** A hang or race gate parks the request itself, so a delay in front of it is meaningless. */
export function supportsDelay(kind) {
  return kind !== 'hang' && kind !== 'race';
}

const isInt = (v) => String(v ?? '').trim() !== '' && Number.isInteger(Number(v));

/**
 * Whether the user may leave `step` (1-based) going forward / submit from it.
 * @param {number} step
 * @param {RuleFields} f
 */
export function isStepValid(step, f) {
  if (step === 1) {
    const p = Number(f.probability);
    return String(f.urlPattern ?? '').trim().length > 0 && isInt(f.probability) && p >= 1 && p <= 100;
  }
  if (step === 2) {
    const delay = Number(f.delayMs);
    const delayOk = String(f.delayMs ?? '').trim() === '' || (Number.isInteger(delay) && delay >= 0 && delay <= MAX_DELAY_MS);
    if (f.kind === 'delay') return isInt(f.delayMs) && delay > 0 && delay <= MAX_DELAY_MS;
    if (f.kind === 'hang') {
      const s = Number(f.hangFailAfterSec);
      return String(f.hangFailAfterSec ?? '').trim() === '' || (Number.isInteger(s) && s >= 0 && s <= HANG_MAX_FAIL_AFTER_SEC);
    }
    if (f.kind === 'race') {
      const n = Number(f.raceBatch);
      const t = Number(f.raceGiveUpSec);
      return isInt(f.raceBatch) && n >= RACE_MIN_COUNT && n <= RACE_MAX_COUNT
        && isInt(f.raceGiveUpSec) && t >= 1 && t <= RACE_MAX_GIVE_UP_SEC;
    }
    return delayOk;
  }
  if (step === 3) {
    if (f.kind === 'mock') {
      const s = Number(f.mockStatus);
      return isInt(f.mockStatus) && s >= 100 && s <= 599;
    }
    if (f.kind === 'rewrite') return rewriteChangesSomething(f);
  }
  return true;
}

/** A rewrite that changes nothing is a mistake, not a rule. */
export function rewriteChangesSomething(f) {
  return !!(f.rwUrl?.trim() || (f.rwMethod && f.rwMethod !== '*')
    || Object.keys(f.rwHeaders || {}).length > 0 || f.rwBodyOn || (f.cookiesOn && (f.cookieSource || Object.keys(f.cookieExtra || {}).length > 0)));
}

/** Every step this rule needs must be valid before it can be saved. */
export function isRuleValid(f) {
  for (let s = 1; s <= stepCount(f.kind); s++) if (!isStepValid(s, f)) return false;
  return true;
}

const num = (v, fallback) => (String(v ?? '').trim() === '' ? fallback : Number(v));

/**
 * The rule payload (without id/enabled/hit stats) a set of field values stands for.
 * @param {RuleFields} f
 */
export function buildRule(f) {
  /** @type {any} */
  let action;
  switch (f.kind) {
    case 'mock':
      action = { kind: 'mock', statusCode: Number(f.mockStatus), body: f.mockBody ?? '', responseHeaders: f.mockHeaders || {}, cors: !!f.mockCors };
      break;
    case 'fail':
      action = { kind: 'fail', mode: f.failMode || 'error500' };
      break;
    case 'delay':
      action = { kind: 'delay' };
      break;
    case 'hang':
      action = { kind: 'hang', failAfterMs: num(f.hangFailAfterSec, 0) * 1000 };
      break;
    case 'race':
      action = { kind: 'race', batchSize: Number(f.raceBatch), giveUpAfterMs: num(f.raceGiveUpSec, RACE_DEFAULT_GIVE_UP_SEC) * 1000 };
      break;
    case 'rewrite': {
      action = { kind: 'rewrite', headers: f.rwHeaders || {} };
      if (f.rwUrl?.trim()) action.url = f.rwUrl.trim();
      if (f.rwMethod && f.rwMethod !== '*') action.method = f.rwMethod;
      if (f.rwBodyOn) action.body = f.rwBody ?? '';
      if (f.cookiesOn) {
        action.cookies = { extra: f.cookieExtra || {} };
        if (f.cookieSource) action.cookies.sourcePartition = f.cookieSource;
      }
      break;
    }
    default:
      throw new Error(`Unknown rule kind: ${f.kind}`);
  }
  return {
    method: f.method || '*',
    urlPattern: String(f.urlPattern).trim(),
    probability: Number(f.probability) / 100,
    delayMs: supportsDelay(f.kind) ? num(f.delayMs, 0) : 0,
    action,
  };
}

/**
 * The form's values for an existing rule (editing).
 * @param {any} rule
 * @returns {RuleFields}
 */
export function ruleToFields(rule) {
  const a = rule.action || {};
  return {
    method: rule.method || '*',
    urlPattern: rule.urlPattern || '',
    probability: Math.round((rule.probability ?? 1) * 100),
    kind: a.kind || 'mock',
    failMode: a.kind === 'fail' ? a.mode : 'error500',
    delayMs: rule.delayMs ?? (a.kind === 'delay' ? 2000 : 0),
    hangFailAfterSec: a.kind === 'hang' && a.failAfterMs ? Math.round(a.failAfterMs / 1000) : 0,
    raceBatch: a.kind === 'race' ? a.batchSize : RACE_MIN_COUNT,
    raceGiveUpSec: a.kind === 'race' && a.giveUpAfterMs ? Math.round(a.giveUpAfterMs / 1000) : RACE_DEFAULT_GIVE_UP_SEC,
    mockStatus: a.kind === 'mock' ? a.statusCode : 200,
    mockBody: a.kind === 'mock' ? a.body : '',
    mockHeaders: a.kind === 'mock' ? (a.responseHeaders || {}) : {},
    mockCors: a.kind === 'mock' ? !!a.cors : false,
    rwUrl: a.kind === 'rewrite' ? (a.url || '') : '',
    rwMethod: a.kind === 'rewrite' ? (a.method || '*') : '*',
    rwHeaders: a.kind === 'rewrite' ? (a.headers || {}) : {},
    rwBodyOn: a.kind === 'rewrite' && a.body !== undefined,
    rwBody: a.kind === 'rewrite' ? (a.body ?? '') : '',
    cookiesOn: a.kind === 'rewrite' && !!a.cookies,
    cookieSource: a.kind === 'rewrite' ? (a.cookies?.sourcePartition || '') : '',
    cookieExtra: a.kind === 'rewrite' ? (a.cookies?.extra || {}) : {},
  };
}

/** Field values for a rule that has not been configured yet. */
export function defaultFields() {
  return ruleToFields({ method: '*', urlPattern: '', probability: 1, action: { kind: 'mock', statusCode: 200, body: '', responseHeaders: {} } });
}

const failLabel = (mode) => FAIL_MODES.find((m) => m.value === mode)?.label ?? mode;

/**
 * One-line description of what a saved rule does, for the rules table.
 * @param {any} rule
 * @param {(partition: string) => string | undefined} [sourceName] session name for a cookie source
 */
export function describeAction(rule, sourceName = () => undefined) {
  const a = rule.action || {};
  const delay = rule.delayMs ? `, after ${rule.delayMs} ms` : '';
  switch (a.kind) {
    case 'mock': return `Mock ${a.statusCode}${delay}`;
    case 'fail': return `Fail: ${failLabel(a.mode)}${delay}`;
    case 'delay': return `Delay ${rule.delayMs || 0} ms`;
    case 'hang': return a.failAfterMs ? `Hang, fails after ${Math.round(a.failAfterMs / 1000)} s` : 'Hang';
    case 'race': return `Race: sends ${a.batchSize} together`;
    case 'rewrite': {
      const parts = [];
      if (a.url) parts.push('URL');
      if (a.method) parts.push(`method ${a.method}`);
      const h = Object.keys(a.headers || {}).length;
      if (h) parts.push(`${h} header${h === 1 ? '' : 's'}`);
      if (a.body !== undefined) parts.push('body');
      if (a.cookies) {
        const name = a.cookies.sourcePartition ? sourceName(a.cookies.sourcePartition) : undefined;
        parts.push(a.cookies.sourcePartition ? `cookies from ${name ?? 'a closed session'}` : 'cookies');
      }
      return `Rewrite: ${parts.join(', ') || 'nothing yet'}${delay}`;
    }
    default: return String(a.kind ?? 'Unknown');
  }
}

/**
 * One-line description of the rule being built, e.g. "Mock 200 for GET `https://api.example.com/*`".
 * @param {RuleFields} f
 */
export function summarizeRule(f) {
  const url = String(f.urlPattern ?? '').trim() || '*';
  const method = f.method && f.method !== '*' ? `${f.method} ` : '';
  const pct = Number(f.probability);
  const how = pct < 100 ? `, ${pct}% of requests` : '';
  const rule = buildRule({ ...f, urlPattern: url });
  return `${describeAction(rule)} on ${method}\`${url}\`${how}`;
}
