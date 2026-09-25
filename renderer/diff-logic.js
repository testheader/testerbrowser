// Pure network-diff logic — no DOM, no testerBrowser/IPC access — so it's
// directly unit-testable (src/__tests__/diff-logic.test.ts). renderer/diff.js
// is the only consumer: it owns fetching the timelines, rendering, and all
// other DOM/IPC state, and calls into this module for the actual comparison.

export const DEFAULT_IGNORED_PARAMS = ['_', 'cb', 'ts', 't', 'timestamp', 'nocache', 'utm_*', 'gclid', 'fbclid'];
export const DEFAULT_IGNORED_HEADERS = ['date', 'age', 'x-request-id', 'set-cookie', 'etag'];

function isIgnoredParam(name, ignoreParams) {
  const lower = name.toLowerCase();
  return ignoreParams.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.endsWith('*') ? lower.startsWith(p.slice(0, -1)) : lower === p;
  });
}

// A stable comparison key for a request: method + a normalised form of the
// URL. Query params are sorted by name and any matching ignoreParams
// (exact, or a trailing '*' prefix match e.g. 'utm_*') are dropped; the
// fragment is always dropped. In 'path' mode the scheme/host/port are
// dropped too, so the same path on two different hosts (staging vs
// production) resolves to the same key.
export function normaliseKey(method, url, opts = {}) {
  const { mode = 'full', ignoreParams = DEFAULT_IGNORED_PARAMS } = opts;
  let u;
  try { u = new URL(url); } catch { return `${method} ${url}`; }

  const params = [...u.searchParams.entries()]
    .filter(([name]) => !isIgnoredParam(name, ignoreParams))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';

  const path = mode === 'path' ? `${u.pathname}${query}` : `${u.origin}${u.pathname}${query}`;
  return `${method} ${path}`;
}

// True once a fetched timeline hit its query limit — there may be more
// events than were actually returned, so the comparison could be silently
// incomplete. `events.length >= limit` rather than `===`: a fetch can never
// return more than it asked for, so `>=` and `===` agree in practice, but
// `>=` doesn't depend on that never changing.
export function isTruncated(events, limit) {
  return events.length >= limit;
}

// Groups every call to the same normalised key within one session, so a
// page that fires the same request more than once (analytics beacons,
// polling, cache revalidation) doesn't drown out genuine differences
// between sessions. Each call keeps enough (requestId, durationMs, response
// headers, body reference) that computeDiffRows can build a detail block
// without re-reading the raw events.
export function buildRequestMap(events, opts = {}) {
  const reqMeta = new Map(); // requestId -> { method, url }
  const bodies  = new Map(); // requestId -> { body, base64Encoded }
  const result  = new Map();

  // Two passes: a network-body event can appear anywhere relative to its
  // response in the event log (the body arrives asynchronously, after
  // Network.loadingFinished), so request/body metadata is collected fully
  // before any response/failure is matched to it.
  for (const ev of events) {
    if (ev.kind === 'network-request') {
      try {
        const p = JSON.parse(ev.payload);
        reqMeta.set(p.requestId, { method: p.request.method, url: p.request.url });
      } catch {}
    } else if (ev.kind === 'network-body') {
      try {
        const p = JSON.parse(ev.payload);
        bodies.set(p.requestId, { body: p.body, base64Encoded: !!p.base64Encoded });
      } catch {}
    }
  }

  const pushCall = (key, method, url, call) => {
    let entry = result.get(key);
    if (!entry) { entry = { method, url, calls: [] }; result.set(key, entry); }
    entry.calls.push(call);
  };

  for (const ev of events) {
    if (ev.kind === 'network-response') {
      try {
        const p = JSON.parse(ev.payload);
        const meta = reqMeta.get(p.requestId);
        if (!meta) continue;
        const key = normaliseKey(meta.method, meta.url, opts);
        const fromCache = !!(p.response.fromDiskCache || p.response.fromServiceWorker);
        pushCall(key, meta.method, meta.url, {
          status: p.response.status,
          fromCache,
          requestId: p.requestId,
          durationMs: p.durationMs ?? null,
          responseHeaders: p.response.headers || {},
          body: bodies.get(p.requestId) || null,
        });
      } catch {}
    } else if (ev.kind === 'network-failed') {
      try {
        const p = JSON.parse(ev.payload);
        const meta = reqMeta.get(p.requestId);
        if (!meta) continue;
        const key = normaliseKey(meta.method, meta.url, opts);
        pushCall(key, meta.method, meta.url, {
          status: 'FAILED',
          fromCache: false,
          requestId: p.requestId,
          durationMs: p.durationMs ?? null,
          responseHeaders: {},
          body: null,
        });
      } catch {}
    }
  }

  return result;
}

function summarizeCalls(entry) {
  if (!entry || entry.calls.length === 0) return null;
  const statuses = [...new Set(entry.calls.map((c) => c.status))];
  const cacheCount = entry.calls.filter((c) => c.fromCache).length;
  const cache = cacheCount === 0 ? 'none' : cacheCount === entry.calls.length ? 'all' : 'mixed';
  return { label: statuses.join('/'), count: entry.calls.length, cache };
}

// Case-insensitive: added (in b, not a), removed (in a, not b), changed
// (present in both with a different value). Header names in the ignore
// list (case-insensitive) are left out of all three.
export function diffHeaders(a = {}, b = {}, ignore = DEFAULT_IGNORED_HEADERS) {
  const ignoreSet = new Set(ignore.map((h) => h.toLowerCase()));
  const norm = (headers) => {
    const out = {};
    for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
    return out;
  };
  const normA = norm(a);
  const normB = norm(b);

  const added = [];
  const removed = [];
  const changed = [];
  for (const name of new Set([...Object.keys(normA), ...Object.keys(normB)])) {
    if (ignoreSet.has(name)) continue;
    const inA = name in normA;
    const inB = name in normB;
    if (inA && !inB) removed.push({ name, value: normA[name] });
    else if (!inA && inB) added.push({ name, value: normB[name] });
    else if (normA[name] !== normB[name]) changed.push({ name, valueA: normA[name], valueB: normB[name] });
  }
  return { added, removed, changed };
}

function firstCall(entry) {
  return entry && entry.calls.length ? entry.calls[0] : null;
}

// null means "not comparable" (body missing on at least one side), not
// "different" — renderer/diff.js reports that distinctly from a genuine
// mismatch.
function bodiesEqual(bodyA, bodyB) {
  if (!bodyA || !bodyB) return null;
  return bodyA.base64Encoded === bodyB.base64Encoded && bodyA.body === bodyB.body;
}

// Built from the first call on each side only — matches what the detail
// block actually shows (see the ticket's acceptance criteria). null when
// either side has no calls at all (nothing to compare).
function computeDetail(a, b, ignoreHeaders) {
  const ca = firstCall(a);
  const cb = firstCall(b);
  if (!ca || !cb) return null;
  const headerDiff = diffHeaders(ca.responseHeaders, cb.responseHeaders, ignoreHeaders);
  const headersDiffer = headerDiff.added.length > 0 || headerDiff.removed.length > 0 || headerDiff.changed.length > 0;
  return {
    headerDiff,
    headersDiffer,
    bodiesMatch: bodiesEqual(ca.body, cb.body),
    bodySizeA: ca.body ? ca.body.body.length : null,
    bodySizeB: cb.body ? cb.body.body.length : null,
    durationA: ca.durationMs,
    durationB: cb.durationMs,
  };
}

function withDetailAndCategory(row, a, b, ignoreHeaders) {
  const detail = computeDetail(a, b, ignoreHeaders);
  row.detail = detail;
  // A "same" row (status matches) can still have a secondary "differs"
  // marker for headers/body — its category is deliberately left
  // unchanged so the same/diff/only-a/only-b legend counts don't shift.
  row.headerBodyDiffer = !!(detail && (detail.headersDiffer || detail.bodiesMatch === false));
  return row;
}

function makeGroupedRow(key, a, b, ignoreHeaders) {
  const sa = summarizeCalls(a);
  const sb = summarizeCalls(b);
  let category;
  if (sa && !sb) category = 'only-a';
  else if (!sa && sb) category = 'only-b';
  else if (sa.label === sb.label) category = 'same';
  else category = 'diff';
  return withDetailAndCategory({ key, method: (a ?? b).method, url: (a ?? b).url, a: sa, b: sb, category }, a, b, ignoreHeaders);
}

function makeCallRow(key, a, b, index, ignoreHeaders) {
  const callA = a?.calls[index];
  const callB = b?.calls[index];
  const cellA = callA ? { label: String(callA.status), count: 1, cache: callA.fromCache ? 'all' : 'none' } : null;
  const cellB = callB ? { label: String(callB.status), count: 1, cache: callB.fromCache ? 'all' : 'none' } : null;
  let category;
  if (cellA && !cellB) category = 'only-a';
  else if (!cellA && cellB) category = 'only-b';
  else if (cellA.label === cellB.label) category = 'same';
  else category = 'diff';
  // Single-call detail comparison uses that exact call, not necessarily
  // a.calls[0]/b.calls[0] — build a one-call "entry" so computeDetail's
  // firstCall() picks up the right one.
  const soloA = callA ? { calls: [callA] } : null;
  const soloB = callB ? { calls: [callB] } : null;
  return withDetailAndCategory(
    { key: `${key}#${index}`, method: (a ?? b).method, url: (a ?? b).url, a: cellA, b: cellB, category },
    soloA, soloB, ignoreHeaders
  );
}

// Builds the comparison rows from two already-built request maps, without
// touching raw events — so switching "Group duplicates" or re-running with
// a different ignoreHeaders set never needs a re-fetch.
export function computeDiffRows(mapA, mapB, opts = {}) {
  const { groupDuplicates = true, ignoreHeaders = DEFAULT_IGNORED_HEADERS } = opts;
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
  const rows = [];

  for (const key of allKeys) {
    const a = mapA.get(key);
    const b = mapB.get(key);
    if (groupDuplicates) {
      rows.push(makeGroupedRow(key, a, b, ignoreHeaders));
    } else {
      const maxLen = Math.max(a?.calls.length ?? 0, b?.calls.length ?? 0);
      for (let i = 0; i < maxLen; i++) rows.push(makeCallRow(key, a, b, i, ignoreHeaders));
    }
  }

  rows.sort((x, y) => {
    const order = { diff: 0, 'only-a': 1, 'only-b': 2, same: 3 };
    return (order[x.category] ?? 9) - (order[y.category] ?? 9) || x.key.localeCompare(y.key);
  });

  return rows;
}
