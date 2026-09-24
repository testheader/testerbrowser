import { BrowserWindow, WebContentsView, session as electronSession, Menu, clipboard, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { SessionRecorder } from './recorder';
import { DownloadManager } from './downloadManager';
import { PermissionManager } from './permissionManager';
import { AppLog } from './appLogger';

import { genFirstName, genLastName, genFullName, genEmail, genUUID, genDate, genPhone, genAddress, resolveTemplate } from './testdata';
import { COLLECT_FRAME_SCRIPT, buildRestoreFrameScript } from './snapshotScripts';
import {
  RGB, WCAG_AA_NORMAL, WCAG_AA_LARGE, WCAG_AAA_NORMAL, WCAG_AAA_LARGE,
  contrastRatio, isLargeText, parseCssColor,
} from './a11yContrast';

// ─────────────────────────────────────────────────────────────────────────────

// #227: SessionManager's default logger when none is injected (existing unit
// tests construct it directly without one).
const NOOP_LOG: AppLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

export interface MockRule {
  id: string;
  urlPattern: string;
  method: string;
  statusCode: number;
  body: string;
  responseHeaders: Record<string, string>;
  // Request headers from the captured call this rule was created from, kept
  // only as read-only provenance in the panel — never used for matching.
  // Undefined for a rule composed by hand rather than from a real request.
  requestHeaders?: Record<string, string>;
  enabled: boolean;
  hitCount: number;
  lastHitAt: number | null;
}

// Pulled out as a pure function so the Fetch.fulfillRequest shape a mock rule
// produces can be unit-tested without the CDP debugger/session plumbing
// around it. responseHeaders defaults to {} for a rule saved before that
// field existed (or built by hand without one).
export function buildMockFulfillParams(rule: MockRule): { responseCode: number; responseHeaders: { name: string; value: string }[]; body: string } {
  return {
    responseCode: rule.statusCode,
    responseHeaders: Object.entries(rule.responseHeaders || {}).map(([name, value]) => ({ name, value })),
    body: Buffer.from(rule.body).toString('base64'),
  };
}

// Pure so an edit's merge behaviour is unit-testable directly: id, hitCount
// and lastHitAt are stripped from the incoming patch even if present, so an
// edit can never reset a rule's identity or hit history regardless of what
// the caller sends.
export function applyMockRulePatch(rule: MockRule, patch: Partial<MockRule>): MockRule {
  const { id: _id, hitCount: _hitCount, lastHitAt: _lastHitAt, ...safePatch } = patch;
  return { ...rule, ...safePatch };
}

// Rule IDs owned by sibling A11y tab tickets, disabled in the axe-core run
// so results never duplicate what's already surfaced elsewhere in the panel:
// color-contrast (#194), image-alt/label (#196), heading-order and the full
// landmark-*/region family (#195). Verified against axe-core 4.13.0's own
// axe.getRules() — re-check this list against future axe-core upgrades, the
// landmark rule set in particular has grown across releases.
export const A11Y_VIOLATIONS_EXCLUDED_RULES = [
  'color-contrast',
  'image-alt',
  'label',
  'heading-order',
  'landmark-banner-is-top-level',
  'landmark-complementary-is-top-level',
  'landmark-contentinfo-is-top-level',
  'landmark-main-is-top-level',
  'landmark-no-duplicate-banner',
  'landmark-no-duplicate-contentinfo',
  'landmark-no-duplicate-main',
  'landmark-one-main',
  'landmark-unique',
  'region',
];

export function buildAxeRuleConfig(): Record<string, { enabled: boolean }> {
  const config: Record<string, { enabled: boolean }> = {};
  for (const id of A11Y_VIOLATIONS_EXCLUDED_RULES) config[id] = { enabled: false };
  return config;
}

// Runs entirely in-page via executeJavaScript (same pattern as
// getLocalStorage below) — walks the DOM to find visible leaf-text elements
// and resolves each one's effective background by walking up the ancestor
// chain past transparent backgrounds, same as a browser would composite it.
// A background-image anywhere in that walk means no reliable solid color
// exists, so the element is flagged rather than scored. The actual contrast
// ratio math happens back in the main process (a11yContrast.ts), not here,
// so that formula stays unit-testable without a DOM.
const CONTRAST_SCAN_SCRIPT = `
(function() {
  function isVisible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function hasDirectText(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) return true;
    }
    return false;
  }
  function isTransparent(colorStr) {
    if (!colorStr) return true;
    const m = colorStr.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return true;
    const parts = m[1].split(',').map(function(s) { return parseFloat(s.trim()); });
    const a = parts.length > 3 ? parts[3] : 1;
    return a === 0;
  }
  function effectiveBackground(el) {
    var node = el;
    while (node) {
      var cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { backgroundImage: true };
      if (!isTransparent(cs.backgroundColor)) return { color: cs.backgroundColor };
      node = node.parentElement;
    }
    return { color: 'rgb(255, 255, 255)' };
  }
  function selectorFor(el) {
    var sel = el.tagName.toLowerCase();
    if (el.id) return sel + '#' + el.id;
    if (el.className && typeof el.className === 'string' && el.className.trim()) {
      sel += '.' + el.className.trim().split(/\\s+/).join('.');
    }
    return sel;
  }

  var results = [];
  var els = document.querySelectorAll('body *');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!hasDirectText(el) || !isVisible(el)) continue;
    var cs = getComputedStyle(el);
    var bg = effectiveBackground(el);
    results.push({
      selector: selectorFor(el),
      text: el.textContent.trim().slice(0, 60),
      color: cs.color,
      backgroundColor: bg.backgroundImage ? null : bg.color,
      backgroundImage: !!bg.backgroundImage,
      fontSize: parseFloat(cs.fontSize),
      fontWeight: parseInt(cs.fontWeight, 10) || 400,
    });
  }
  return JSON.stringify(results);
})()
`;

interface RawContrastEntry {
  selector: string;
  text: string;
  color: string;
  backgroundColor: string | null;
  backgroundImage: boolean;
  fontSize: number;
  fontWeight: number;
}

export interface ContrastIssue {
  selector: string;
  text: string;
  color: string;
  backgroundColor: string | null;
  ratio: number | null;
  threshold: number | null;
  isLarge: boolean;
  status: 'aa-fail' | 'aaa-note' | 'unknown-background';
}

// Runs entirely in-page via executeJavaScript (same pattern as
// getLocalStorage/CONTRAST_SCAN_SCRIPT) — the label-association rules
// (label[for], wrapping label, aria-label, aria-labelledby) all need live
// DOM queries (querySelector, closest, getElementById), so unlike the
// contrast checker's ratio math there's no DOM-free part worth pulling out
// into a separately unit-tested module; this ticket's test plan explicitly
// allows relying on e2e coverage instead for that reason.
const ALT_LABEL_SCAN_SCRIPT = `
(function() {
  function selectorFor(el) {
    var sel = el.tagName.toLowerCase();
    if (el.id) return sel + '#' + el.id;
    if (el.className && typeof el.className === 'string' && el.className.trim()) {
      sel += '.' + el.className.trim().split(/\\s+/).join('.');
    }
    return sel;
  }

  var images = [];
  var imgEls = document.querySelectorAll('img');
  for (var i = 0; i < imgEls.length; i++) {
    var img = imgEls[i];
    if (img.hasAttribute('alt')) continue; // alt="" is a valid, deliberate "decorative" marker — not flagged
    var rect = img.getBoundingClientRect();
    var role = (img.getAttribute('role') || '').toLowerCase();
    var likelyDecorative = role === 'presentation' || role === 'none' || (rect.width <= 2 && rect.height <= 2);
    images.push({ selector: selectorFor(img), src: img.getAttribute('src') || '', likelyDecorative: likelyDecorative });
  }

  function hasAccessibleLabel(el) {
    if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return true;
    if (el.closest('label')) return true;
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return true;
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var ids = labelledBy.split(/\\s+/).filter(Boolean);
      for (var j = 0; j < ids.length; j++) {
        var ref = document.getElementById(ids[j]);
        if (ref && ref.textContent.trim()) return true;
      }
    }
    return false;
  }

  var EXCLUDED_INPUT_TYPES = ['hidden', 'button', 'submit', 'reset', 'image'];
  var fields = [];
  var fieldEls = document.querySelectorAll('input, select, textarea');
  for (var k = 0; k < fieldEls.length; k++) {
    var el = fieldEls[k];
    if (el.tagName === 'INPUT') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (EXCLUDED_INPUT_TYPES.indexOf(type) !== -1) continue;
    }
    if (!hasAccessibleLabel(el)) fields.push({ selector: selectorFor(el), type: el.tagName.toLowerCase() });
  }

  return JSON.stringify({ images: images, fields: fields });
})()
`;

export interface AltIssue {
  selector: string;
  src: string;
  likelyDecorative: boolean;
}

export interface LabelIssue {
  selector: string;
  type: string;
}

export interface AltLabelIssues {
  images: AltIssue[];
  fields: LabelIssue[];
}

// Standard sequential-focus-navigation ordering: elements with a positive
// tabindex first, ascending, ties broken by DOM order; then everything else
// (tabindex 0 or naturally focusable) in DOM order. Pulled out as a pure
// function so it's unit-testable — the in-page overlay script below
// necessarily duplicates this same rule as plain JS text, since it can't
// import a compiled module into the injected page context.
export interface TabOrderCandidate {
  tabindex: number;
  domIndex: number;
}

export function compareTabOrder(a: TabOrderCandidate, b: TabOrderCandidate): number {
  const aPos = a.tabindex > 0 ? a.tabindex : Infinity;
  const bPos = b.tabindex > 0 ? b.tabindex : Infinity;
  if (aPos !== bPos) return aPos - bPos;
  return a.domIndex - b.domIndex;
}

export interface FocusOrderItem {
  selector: string;
  order: number;
  tabindex: number;
  text: string;
  noVisibleIndicator: boolean;
}

// Shared by FOCUS_OVERLAY_ENABLE_SCRIPT (#197) and FOCUS_CANDIDATES_LIST_SCRIPT
// (#198, which needs the same element count and ordering to know the
// expected trap-free traversal length and terminal element) — defines
// isFocusable/computeFocusCandidates as plain functions, interpolated
// verbatim into each injected script's own IIFE rather than composed at the
// Node level, since there's no way to share an actual JS module with page-
// injected script text.
const FOCUS_CANDIDATES_JS = `
  function isVisible(el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isFocusable(el) {
    if (el.hasAttribute('inert') || el.closest('[inert]')) return false;
    if (el.disabled || el.hidden) return false;
    var attr = el.getAttribute('tabindex');
    if (attr !== null && parseInt(attr, 10) < 0) return false;
    if (!isVisible(el)) return false;
    var tag = el.tagName.toLowerCase();
    return (tag === 'a' && el.hasAttribute('href')) ||
      (tag === 'area' && el.hasAttribute('href')) ||
      tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' ||
      el.tabIndex >= 0;
  }

  function computeFocusCandidates() {
    var all = Array.prototype.slice.call(document.querySelectorAll('*'));
    var candidates = [];
    for (var i = 0; i < all.length; i++) {
      if (!isFocusable(all[i])) continue;
      var attr = all[i].getAttribute('tabindex');
      candidates.push({ el: all[i], tabindex: attr !== null ? parseInt(attr, 10) : 0, domIndex: candidates.length });
    }
    candidates.sort(function(a, b) {
      var aPos = a.tabindex > 0 ? a.tabindex : Infinity;
      var bPos = b.tabindex > 0 ? b.tabindex : Infinity;
      if (aPos !== bPos) return aPos - bPos;
      return a.domIndex - b.domIndex;
    });
    return candidates;
  }

  function selectorForFocusable(el) {
    var sel = el.tagName.toLowerCase();
    if (el.id) sel += '#' + el.id;
    return sel;
  }
`;

// Guarded by window.__a11yFocusSetup, same idiom as __a11yHoverSetup in
// setA11yInspect below. Computes tab order, draws a numbered badge per
// element (in a single overlay root appended to <body>, cleared entirely by
// the disable script), then focuses each element in turn to diff its
// computed outline/box-shadow/border against the unfocused state — an
// element with no detectable change is flagged as having no visible focus
// indicator. Runs synchronously (no CDP awaitPromise needed) and returns the
// list directly as the Runtime.evaluate result.
const FOCUS_OVERLAY_ENABLE_SCRIPT = `
(function() {
  if (window.__a11yFocusSetup) return JSON.stringify(window.__a11yFocusOrderList || []);
  window.__a11yFocusSetup = true;

  ${FOCUS_CANDIDATES_JS}

  var candidates = computeFocusCandidates();

  var overlayRoot = document.createElement('div');
  overlayRoot.id = '__a11yFocusOverlayRoot';
  overlayRoot.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  document.body.appendChild(overlayRoot);

  var previouslyFocused = document.activeElement;
  var results = [];
  for (var idx = 0; idx < candidates.length; idx++) {
    var el = candidates[idx].el;
    var before = getComputedStyle(el);
    var beforeSnapshot = [before.outlineStyle, before.outlineWidth, before.boxShadow, before.borderStyle, before.borderWidth, before.borderColor].join('|');
    el.focus({ preventScroll: true });
    var after = getComputedStyle(el);
    var afterSnapshot = [after.outlineStyle, after.outlineWidth, after.boxShadow, after.borderStyle, after.borderWidth, after.borderColor].join('|');
    el.blur();

    var rect = el.getBoundingClientRect();
    var badge = document.createElement('div');
    badge.className = '__a11yFocusBadge';
    badge.textContent = String(idx + 1);
    badge.style.cssText = 'position:absolute;left:' + Math.round(rect.left + window.scrollX) + 'px;top:' + Math.max(0, Math.round(rect.top + window.scrollY) - 8) +
      'px;background:#ff5252;color:#fff;font:10px/14px monospace;min-width:14px;height:14px;border-radius:7px;' +
      'text-align:center;padding:0 3px;box-shadow:0 0 0 1px #fff;';
    overlayRoot.appendChild(badge);

    results.push({
      selector: selectorForFocusable(el),
      order: idx + 1,
      tabindex: candidates[idx].tabindex,
      text: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 60),
      noVisibleIndicator: beforeSnapshot === afterSnapshot,
    });
  }
  if (previouslyFocused && previouslyFocused !== document.body && document.body.contains(previouslyFocused)) {
    previouslyFocused.focus({ preventScroll: true });
  }

  window.__a11yFocusOrderList = results;
  return JSON.stringify(results);
})()
`;

const FOCUS_OVERLAY_DISABLE_SCRIPT = `
(function() {
  window.__a11yFocusSetup = false;
  window.__a11yFocusOrderList = undefined;
  var root = document.getElementById('__a11yFocusOverlayRoot');
  if (root) root.remove();
})()
`;

// #198's focus-trap walk needs to know N (the expected element count) and
// the expected first/last selectors, computed the same way as #197's
// overlay, without drawing badges or doing the focus/style diff pass.
// Also caches element refs in window.__a11yTrapEls so READ_ACTIVE_ELEMENT_SCRIPT
// can identify the active element by its position index rather than a CSS
// selector string — two different elements with the same tag and no id (e.g.
// two <a> links) would otherwise produce identical descriptors, and the
// classifier would falsely report a cycle when the walk visits both.
const FOCUS_CANDIDATES_LIST_SCRIPT = `
(function() {
  ${FOCUS_CANDIDATES_JS}
  var candidates = computeFocusCandidates();
  window.__a11yTrapEls = candidates.map(function(c) { return c.el; });
  return JSON.stringify(candidates.map(function(c) { return selectorForFocusable(c.el); }));
})()
`;

// Returns the candidate list index of document.activeElement as a string
// (e.g. '2'), falling back to a tag+id selector for elements not in the list.
// Using the positional index — set up by FOCUS_CANDIDATES_LIST_SCRIPT —
// guarantees uniqueness even when multiple elements share the same tag and
// have no id.
const READ_ACTIVE_ELEMENT_SCRIPT = `
(function() {
  var el = document.activeElement;
  if (!el || el === document.body) return '';
  var els = window.__a11yTrapEls;
  if (Array.isArray(els)) {
    var idx = els.indexOf(el);
    if (idx !== -1) return String(idx);
  }
  var sel = el.tagName.toLowerCase();
  if (el.id) sel += '#' + el.id;
  return sel;
})()
`;

export interface FocusTrapDirectionResult {
  passed: boolean;
  kind: 'pass' | 'cycle' | 'dead-end' | 'incomplete';
  trappedElements: string[];
  sequence: string[];
}

export interface FocusTrapResult {
  forward: FocusTrapDirectionResult;
  backward: FocusTrapDirectionResult;
}

// #222 — a discriminated result so a failed audit (CSP blocking eval, a page
// exception, a missing vendored axe.min.js, a detached debugger) can never
// be mistaken by the renderer for "ran cleanly, zero violations".
export type A11yViolationsResult =
  | { ok: true; violations: object[] }
  | { ok: false; error: string };

// The subset of CDP's Runtime.ExceptionDetails this file actually reads.
interface A11yExceptionDetails {
  text?: string;
  exception?: { description?: string };
}

// Pure classification over an already-observed traversal sequence (real Tab/
// Shift+Tab presses, dispatched and read by detectA11yFocusTrap below) — the
// CDP round-trips that produce `sequence` aren't unit-testable, but this
// judgment call is.
//
// A repeat found before `expectedTerminal` is ever reached is a genuine trap
// (focus never escapes to the intended end of the page): a repeat of a
// single element is a dead end, a repeat of more than one is a cycle,
// reported as the deduplicated set of elements between the repeat and its
// first occurrence. Reaching `expectedTerminal` at any point is a pass even
// if the sequence wraps around afterward — normal browsers wrap Tab from the
// last focusable element back toward the first, which is not itself a trap.
export function classifyFocusTrapSequence(sequence: string[], expectedTerminal: string): FocusTrapDirectionResult {
  if (sequence.length === 0) {
    return { passed: false, kind: 'incomplete', trappedElements: [], sequence };
  }
  const terminalIndex = sequence.indexOf(expectedTerminal);
  const seen = new Map<string, number>();
  const searchEnd = terminalIndex === -1 ? sequence.length : terminalIndex;
  for (let i = 0; i < searchEnd; i++) {
    const el = sequence[i];
    if (seen.has(el)) {
      const cycleStart = seen.get(el) as number;
      const trapped = Array.from(new Set(sequence.slice(cycleStart, i)));
      return { passed: false, kind: trapped.length === 1 ? 'dead-end' : 'cycle', trappedElements: trapped, sequence };
    }
    seen.set(el, i);
  }
  if (terminalIndex !== -1) {
    return { passed: true, kind: 'pass', trappedElements: [], sequence };
  }
  return { passed: false, kind: 'incomplete', trappedElements: [], sequence };
}

export type ResilienceType = 'error500' | 'timeout' | 'latency' | 'offline' | 'missing' | 'random500' | 'corrupt';

export interface ResilienceRule {
  id: string;
  type: ResilienceType;
  urlPattern: string;
  // '*' (the default, matching every method) or a single HTTP method — never
  // matched against headers or body, only used to scope which requests this
  // rule degrades.
  method: string;
  probability: number;
  latencyMs: number;
  enabled: boolean;
  hitCount: number;
  lastHitAt: number | null;
  // Provenance from the captured call this rule was created from — read-only
  // display in the panel, never sent anywhere and never part of matching.
  // Undefined for a rule composed by hand.
  requestHeaders?: Record<string, string>;
  requestBody?: string;
}

// Matches CDP's own Fetch.RequestPattern.urlPattern semantics (the pattern
// this rule is ultimately handed to via Fetch.enable — see _applyFetch()):
// '*' matches zero or more characters, '?' matches exactly one character,
// and every other character — including every other regex metacharacter —
// matches itself literally. '*' and '?' are left out of the escape class so
// they're still recognizable as wildcards in the next two steps, then each
// is turned into its regex equivalent.
function matchesGlob(pattern: string, url: string): boolean {
  try {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return re.test(url);
  } catch { return false; }
}

// Pulled out as a pure function so the method-scoping this ticket (#181)
// adds is unit-testable without the CDP debugger/session plumbing around it.
// A missing/'*' method matches every method, same as before this field
// existed — never matched against headers or body, only method + URL.
export function resilienceRuleMatchesRequest(rule: ResilienceRule, request: { method: string; url: string }): boolean {
  return (!rule.method || rule.method === '*' || rule.method === request.method) && matchesGlob(rule.urlPattern, request.url);
}

// A rolling per-tab cap on how many Fetch.requestPaused events get full rule
// matching + recorder tagging per second, regardless of how narrow or broad
// the active rules' urlPattern strings look. _applyFetch()'s hasWildcard
// check only special-cases a *literal* '*'/'' pattern — a pattern like
// '*ad*' takes the normal "scoped" path but still matches nearly every
// resource on a real page (any URL containing "ad" as a substring — "load",
// "header", "admin", ...), which can flood the CDP channel exactly the way
// a bare '*' pattern did before #199's fix, just without tripping that
// string check (#210). Investigated but not conclusively reproduced as an
// app crash in this environment (synthetic bursts up to 3000 concurrent
// requests, mid-navigation refresh + immediate tab switch, and the two
// real sites named in the bug reports all stayed responsive) — this cap is
// added regardless, as cheap, unconditionally-safe insurance: past the
// threshold, a paused request is let straight through via
// Fetch.continueRequest, unmatched and untagged, rather than adding to a
// growing backlog of synchronous rule-matching + SQLite writes.
export const FETCH_PAUSE_RATE_LIMIT = 300;
export const FETCH_PAUSE_RATE_WINDOW_MS = 1000;

export interface FetchPauseRateState { windowStart: number; count: number; }

// Mutates `state` in place (a per-tab counter) and returns whether this call
// is over the cap for its current window. Pulled out pure so the windowing
// behavior is unit-testable without the CDP debugger/session plumbing
// around it — same pattern as matchesGlob/resilienceRuleMatchesRequest above.
export function shouldRateLimitFetchPause(state: FetchPauseRateState, now: number): boolean {
  if (now - state.windowStart >= FETCH_PAUSE_RATE_WINDOW_MS) {
    state.windowStart = now;
    state.count = 0;
  }
  state.count++;
  return state.count > FETCH_PAUSE_RATE_LIMIT;
}

export interface TestSession {
  id: string;
  name: string;
  persistent: boolean;
  partition: string;
  currentUrl: string;
  pinned: boolean;
  color: string;
  view: WebContentsView;
  recorder: SessionRecorder;
  createdAt: number;
  loadedDomains: Set<string>;
  a11yInspecting: boolean;
  devToolsOpen: boolean;
  a11yFocusOverlayOn: boolean;
  emulation: EmulationOverrides | null;
  // Real UA captured at session creation, before any override — the only
  // way to restore it once webContents.setUserAgent() has been called,
  // since Electron doesn't expose "reset to default" directly.
  defaultUserAgent: string;
}

export interface HistoryEntry {
  url: string;
  ts: number;
  failed?: boolean;
}

// One entry per frame (main frame + same-page iframes) inside a session
// snapshot. Storage/IndexedDB/history/scroll/fields are captured and
// restored; reactState is diagnostic-only (see snapshotScripts.ts) and is
// never fed back into a page on import.
export interface FrameSnapshot {
  url: string;
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  indexedDB?: Record<string, {
    version: number;
    stores: Record<string, { keyPath: string | string[] | null; autoIncrement: boolean; records: { key: unknown; value: unknown }[] }>;
  }>;
  fields?: { sel: string; kind: 'value' | 'checked'; value?: string; checked?: boolean }[];
  scroll?: { x: number; y: number };
  historyState?: unknown;
  reactState?: { note: string; nodes: { path: string; state: unknown }[] };
  warnings?: string[];
}

export interface SessionSnapshot {
  version: 2;
  ts: number;
  sessionName: string;
  url: string;
  cookies: Electron.Cookie[];
  frames: FrameSnapshot[];
  warnings: string[];
}

export interface EmulationOverrides {
  timezone?: string;
  locale?: string;
  latitude?: number;
  longitude?: number;
  timeOffsetMs?: number;
  userAgent?: string;
}

// Overrides window.Date/Date.now() on every new document with a fixed
// offset from real wall-clock time, so the spoofed clock keeps advancing
// at normal speed instead of freezing at one instant.
function buildDateOverrideScript(offsetMs: number): string {
  return `(() => {
    if (window.__tbDateOverridden) return;
    window.__tbDateOverridden = true;
    const __tbOffset = ${offsetMs};
    const RealDate = Date;
    function TBDate(...args) {
      if (!new.target) return new RealDate(RealDate.now() + __tbOffset).toString();
      if (args.length === 0) return new RealDate(RealDate.now() + __tbOffset);
      return new RealDate(...args);
    }
    TBDate.prototype = RealDate.prototype;
    TBDate.now = () => RealDate.now() + __tbOffset;
    TBDate.parse = RealDate.parse;
    TBDate.UTC = RealDate.UTC;
    Object.defineProperty(window, 'Date', { value: TBDate, writable: true, configurable: true });
  })();`;
}

// Chromium's CDP Emulation.setUserAgentOverride only touches navigator.userAgent
// (and the request header, alongside webContents.setUserAgent()) — it leaves
// navigator.userAgentData / Sec-CH-UA-* Client Hints reporting the *real*
// browser unless userAgentMetadata is supplied too, which would silently
// contradict the spoofed UA on any site that reads them. Derive a plausible
// metadata object from the UA string itself rather than requiring a second
// field the tester would have to keep in sync by hand.
function buildUserAgentMetadata(ua: string): {
  brands: { brand: string; version: string }[];
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
} {
  const mobile = /Mobi|Android|iPhone|iPad/i.test(ua);
  const platform =
    /iPhone|iPad|iPod/i.test(ua) ? 'iOS' :
    /Android/i.test(ua) ? 'Android' :
    /Windows/i.test(ua) ? 'Windows' :
    /Mac OS X/i.test(ua) ? 'macOS' :
    /Linux/i.test(ua) ? 'Linux' : '';
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const brands = chromeMatch
    ? [{ brand: 'Chromium', version: chromeMatch[1] }, { brand: 'Google Chrome', version: chromeMatch[1] }]
    : [];
  return { brands, platform, platformVersion: '', architecture: '', model: '', mobile };
}

const TAB_COLORS = [
  '#e06c75', '#61afef', '#98c379', '#c678dd',
  '#e5c07b', '#56b6c2', '#d19a66', '#be5046',
  '#2bbac5', '#d4896a',
];

function getHostname(url: string): string {
  try { return new URL(url).hostname || 'New tab'; } catch { return 'New tab'; }
}

// Resolved at runtime — points to renderer/newtab.html whether packaged or in dev
const MAX_CAPTURE_PX = 16384;
const NEWTAB_FILE = path.join(__dirname, '..', '..', 'renderer', 'newtab.html');
const NEWTAB_PRELOAD = path.join(__dirname, '..', 'preload', 'newtab.js');

function isNewtabUrl(url: string) {
  return url.startsWith('file://') && url.includes('newtab.html');
}

function isSafeUrl(url: string): boolean {
  try { const { protocol } = new URL(url); return protocol === 'http:' || protocol === 'https:'; }
  catch { return false; }
}

// ─── Recording/Playback ───────────────────────────────────────────────────────

const RECORDING_SCRIPT = `(function(){
  if(window.__tbRecording)return;
  window.__tbRecording=true;
  window.__tbTestSteps=window.__tbTestSteps||[];
  function esc(s){return(s||'').replace(/\\\\/g,'\\\\').replace(/"/g,'\\"');}
  function genSel(el){
    if(!el)return'';
    var td=el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-cy')||el.getAttribute('data-qa');
    if(td)return'[data-testid="'+esc(td)+'"]';
    if(el.id&&/^[a-zA-Z_-]/.test(el.id)&&el.id.length<80)return'#'+CSS.escape(el.id);
    var nm=el.getAttribute('name');
    if(nm)return el.tagName.toLowerCase()+'[name="'+esc(nm)+'"]';
    var al=el.getAttribute('aria-label');
    if(al)return'[aria-label="'+esc(al)+'"]';
    var parts=[],cur=el;
    while(cur&&cur!==document.body&&parts.length<6){
      if(cur.id&&/^[a-zA-Z_-]/.test(cur.id)){parts.unshift('#'+CSS.escape(cur.id));break;}
      var s=cur.tagName.toLowerCase();
      var sibs=cur.parentElement?[].slice.call(cur.parentElement.children).filter(function(x){return x.tagName===cur.tagName;}):[];
      if(sibs.length>1)s+=':nth-of-type('+(sibs.indexOf(cur)+1)+')';
      parts.unshift(s);cur=cur.parentElement;
    }
    return parts.join(' > ');
  }
  function addStep(step){window.__tbTestSteps.push(Object.assign({id:Date.now()+'_'+Math.random().toString(36).slice(2),timestamp:Date.now(),url:location.href},step));}
  document.addEventListener('click',function(e){
    var el=e.target;if(!el||el===document.documentElement||el===document.body)return;
    addStep({type:'click',selector:genSel(el),description:((el.textContent||el.value||el.getAttribute('aria-label')||'').trim()).slice(0,60),tagName:el.tagName.toLowerCase()});
  },true);
  function upsertFill(el){
    if(!el||!('value' in el))return;
    var pw=el.type==='password';
    var sel=genSel(el);
    var steps=window.__tbTestSteps;
    var last=steps.length?steps[steps.length-1]:null;
    if(last&&last.type==='fill'&&last.selector===sel){
      last.value=pw?'[hidden]':el.value;last.sensitive=pw;last.timestamp=Date.now();
    }else{
      addStep({type:'fill',selector:sel,value:pw?'[hidden]':el.value,sensitive:pw,tagName:el.tagName.toLowerCase()});
    }
  }
  document.addEventListener('input',function(e){upsertFill(e.target);},true);
  document.addEventListener('change',function(e){upsertFill(e.target);},true);
  window.addEventListener('popstate',function(){addStep({type:'navigate',url:location.href});});
  var op=history.pushState.bind(history);history.pushState=function(){op.apply(history,arguments);addStep({type:'navigate',url:location.href});};
  var or=history.replaceState.bind(history);history.replaceState=function(){or.apply(history,arguments);addStep({type:'navigate',url:location.href});};
})();`;

export interface TestStep {
  id: string;
  type: 'navigate' | 'click' | 'fill' | 'assert-visible' | 'assert-not-visible' | 'assert-text' | 'assert-value' | 'assert-url' | 'assert-attr' | 'assert-enabled' | 'wait-visible' | 'wait-navigation';
  selector?: string;
  value?: string;
  url?: string;
  attr?: string;
  timestamp?: number;
  description?: string;
  tagName?: string;
  sensitive?: boolean;
}

// Pulled out as a pure function so the followAlong:stepResult payload shape
// for a mirrored navigation (#186) is unit-testable without the WebContents/
// pairing plumbing around it.
export function buildNavMirrorStepResult(
  kind: 'navigate' | 'navigate-in-page', url: string, error?: string
): { step: { type: 'navigate' | 'navigate-in-page'; url: string }; result: { success: boolean; error?: string } } {
  return {
    step: { type: kind, url },
    result: error === undefined ? { success: true } : { success: false, error },
  };
}

interface FollowPairing {
  leaderId: string;
  followerId: string;
  mirrorNavigation: boolean;
  // Maps step id → the value last relayed to the follower. 'fill' steps are
  // mutated in place as the user types (see upsertFill), so the same step id
  // must be re-relayed each time its value grows, not just once.
  relayedSteps: Map<string, string>;
  pollTimer: ReturnType<typeof setInterval>;
  navHandler: (_e: unknown, url: string) => void;
  navInPageHandler: (_e: unknown, url: string) => void;
}

function buildPlaybackScript(step: TestStep): string {
  const sel = JSON.stringify(step.selector ?? '');
  const val = JSON.stringify(step.value ?? '');
  const helpers = `var __wait=function(fn,ms){return new Promise(function(res,rej){var s=Date.now();(function poll(){try{var r=fn();if(r!==null&&r!==false&&r!==undefined){res(r);return;}}catch(ex){}if(Date.now()-s>(ms||10000)){rej(new Error('Timeout'));return;}setTimeout(poll,120);})();});};var __find=function(sel){var el=document.querySelector(sel);if(!el)throw new Error('Element not found: '+sel);return el;};var __vis=function(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';};`;
  switch (step.type) {
    case 'navigate': return `(function(){try{location.href=${JSON.stringify(step.url??'')};return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    case 'click': return `(async function(){${helpers}try{await __wait(function(){var el=document.querySelector(${sel});return el&&__vis(el)?el:null;});__find(${sel}).click();return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    case 'fill': return `(async function(){${helpers}try{await __wait(function(){var el=document.querySelector(${sel});return el&&__vis(el)?el:null;});var el=__find(${sel});el.focus();el.value=${val};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    case 'assert-visible': return `(function(){var __vis=function(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';};try{var el=document.querySelector(${sel});if(!el||!__vis(el))return {success:false,error:'Not visible: '+${sel}};return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    case 'assert-not-visible': return `(function(){var el=document.querySelector(${sel});function v(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0;}if(el&&v(el))return {success:false,error:'Element visible: '+${sel}};return {success:true};})()`;
    case 'assert-text': return `(function(){try{var el=document.querySelector(${sel});if(!el)return {success:false,error:'Not found: '+${sel}};var t=(el.textContent||'').trim();if(!t.includes(${val}))return {success:false,error:'Text "'+t+'" does not contain "'+${val}+'"'};return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    case 'assert-value': return `(function(){try{var el=document.querySelector(${sel});if(!el)return {success:false,error:'Not found: '+${sel}};var v=String(el.value||'');if(v!==${val})return {success:false,error:'Value "'+v+'" !== "'+${val}+'"'};return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    case 'assert-url': return `(function(){var u=location.href;if(!u.includes(${val})&&u!==${val})return {success:false,error:'URL "'+u+'" does not match "'+${val}+'"'};return {success:true};})()`;
    case 'assert-enabled': return `(function(){try{var el=document.querySelector(${sel});if(!el)return {success:false,error:'Not found: '+${sel}};if(el.disabled)return {success:false,error:'Element is disabled'};return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    case 'assert-attr': return `(function(){try{var el=document.querySelector(${sel});if(!el)return {success:false,error:'Not found: '+${sel}};var v=el.getAttribute(${JSON.stringify(step.attr??'')});if(v!==${val})return {success:false,error:'Attr mismatch: "'+v+'"'};return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    case 'wait-visible': return `(async function(){${helpers}try{await __wait(function(){var el=document.querySelector(${sel});return el&&__vis(el)?el:null;},15000);return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    case 'wait-navigation': return `(async function(){${helpers}try{await __wait(function(){return document.readyState==='complete'?true:null;},15000);return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    default: return `(function(){return {success:false,error:'Unknown step type'};})()`;
  }
}

export class SessionManager {
  private win: BrowserWindow;
  private sessions = new Map<string, TestSession>();
  private activeId: string | null = null;
  private dbDir: string;
  private consoleHeight = 220;
  private topBarHeight = 91;
  private rightPanelWidth = 0;
  private isViewVisible = true;
  private tabOrder: string[] = [];
  private sessionNotes = new Map<string, string>();
  private colorIndex = 0;
  private downloadManager: DownloadManager;
  private hookedPartitions = new Set<string>();
  private permissionManager: PermissionManager;
  private getRedactHeaders: () => boolean;
  private recordingHandlers = new Map<string, () => void>();
  // Accumulates recorded steps (keyed by step id) across a session's recording, so
  // steps survive a full page navigation destroying the page's own JS context.
  private recordingBuffers = new Map<string, Map<string, TestStep>>();
  // Live leader→follower links ("Follow Along"), keyed by leader session id.
  private followPairings = new Map<string, FollowPairing>();
  // CDP script identifier of the injected Date-override shim, keyed by session id.
  private dateOverrideScripts = new Map<string, string>();
  // Per-session navigation history, newest entry last — cleared on destroy.
  private sessionHistory = new Map<string, HistoryEntry[]>();
  // Mock/Resilience rules are a property of the session *partition* (cookies,
  // storage, cache — the thing "isolated sessions" actually means), not of
  // any one TestSession/tab object representing it — keyed by partition so
  // rules survive that tab being destroyed and a new one created for the
  // same partition (reopen, "New tab in this session"). Never cleared in
  // destroySession(): another open tab, or a future reopen, may still need
  // the entry. Not persisted to disk (see #209's "Out of scope").
  private mockRulesByPartition = new Map<string, MockRule[]>();
  private resilienceRulesByPartition = new Map<string, ResilienceRule[]>();
  // Lazily-read, cached contents of the vendored axe-core bundle — read once
  // per app run rather than on every violations scan. '' (not null) marks a
  // failed read so we don't retry the disk hit on every call.
  private axeSource: string | null = null;
  // #227: replaces the old recordFeatureError(message) callback — every call
  // site now names its own source ('sessions' for nearly all of them) and
  // can attach a sessionId/ctx. Defaults to a no-op so existing unit tests
  // that construct SessionManager without a logger don't need updating.
  private log: AppLog;
  // Notifies the caller whenever a session is created/destroyed or navigates
  // — index.ts write-throughs the current URL list to disk on this so a hard
  // crash's next launch can recover what was open (see persistSessionUrls()).
  private onSessionsChanged: () => void;

  constructor(
    win: BrowserWindow,
    getRedactHeaders: () => boolean,
    logger: AppLog = NOOP_LOG,
    onSessionsChanged: () => void = () => {}
  ) {
    this.win = win;
    this.dbDir = path.join(app.getPath('userData'), 'recordings');
    this.getRedactHeaders = getRedactHeaders;
    this.log = logger;
    this.onSessionsChanged = onSessionsChanged;
    this.downloadManager = new DownloadManager(win);
    this.permissionManager = new PermissionManager(win);
    this.win.on('resize', () => this.layoutActive());
  }

  // #227: shared by the many `dbg.sendCommand(...).catch(...)` call sites
  // below that were previously silent — a rejected CDP command means an
  // override, mock response or cleanup step silently never took effect.
  private warnCdpFailure(sessionId: string, command: string, e: unknown) {
    this.log.warn('sessions', `CDP command '${command}' failed`, { sessionId, error: String(e) });
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      persistent: s.persistent,
      partition: s.partition,
      url: s.currentUrl,
      pinned: s.pinned,
      color: s.color,
      createdAt: s.createdAt,
    }));
  }

  createSession(
    name: string,
    opts: { persistent?: boolean; startUrl?: string; partition?: string; color?: string } = {}
  ): TestSession {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partition = opts.partition ?? (opts.persistent ? `persist:${id}` : id);
    // Seed the rule buckets for this partition if this is the first tab ever
    // to represent it — a partition passed in explicitly (reopen, "New tab
    // in this session") may already have an entry, which must be left alone.
    if (!this.mockRulesByPartition.has(partition)) this.mockRulesByPartition.set(partition, []);
    if (!this.resilienceRulesByPartition.has(partition)) this.resilienceRulesByPartition.set(partition, []);
    const ses = electronSession.fromPartition(partition);

    this.downloadManager.attach(ses);
    this.permissionManager.attach(ses, partition);

    const view = new WebContentsView({
      webPreferences: { session: ses, contextIsolation: true, sandbox: true, preload: NEWTAB_PRELOAD },
    });

    const recorder = new SessionRecorder(view.webContents, {
      sessionId: id,
      dbDir: this.dbDir,
      redactSensitiveHeaders: this.getRedactHeaders(),
    });

    const color = opts.color ?? TAB_COLORS[this.colorIndex++ % TAB_COLORS.length];
    const testSession: TestSession = {
      id, name,
      persistent: !!opts.persistent || partition.startsWith('persist:'),
      partition,
      currentUrl: opts.startUrl || '',
      pinned: false,
      color,
      view, recorder,
      createdAt: Date.now(),
      loadedDomains: new Set<string>(),
      a11yInspecting: false,
      a11yFocusOverlayOn: false,
      emulation: null,
      defaultUserAgent: view.webContents.getUserAgent(),
      devToolsOpen: false,
    };
    const fetchPauseRateState: FetchPauseRateState = { windowStart: 0, count: 0 };

    // Handle CDP events: Fetch.requestPaused for mock/resilience rules, Runtime.bindingCalled for a11y hover
    view.webContents.debugger.on('message', (_e: unknown, method: string, params: Record<string, unknown>) => {
      if (method === 'Runtime.bindingCalled' && (params as { name?: string }).name === '__a11yHover' && testSession.a11yInspecting) {
        try {
          const { x, y } = JSON.parse((params as { payload?: string }).payload ?? '{}') as { x?: number; y?: number };
          if (typeof x === 'number' && typeof y === 'number') {
            (async () => {
              const dbg = view.webContents.debugger;
              const loc = await dbg.sendCommand('DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: false }) as { backendNodeId?: number };
              if (!loc.backendNodeId) return;
              const ax = await dbg.sendCommand('Accessibility.queryAXTree', { backendNodeId: loc.backendNodeId }) as { nodes?: unknown[] };
              const node = ax.nodes?.[0];
              if (node) this.win.webContents.send('a11y:nodeHovered', node);
            })().catch(() => {}); // silent: fires per mousemove while a11y inspect is on — too high-frequency to log
          }
        // silent: fires per mousemove while a11y inspect is on — too high-frequency to log
        } catch {}
        return;
      }
      if (method === 'Runtime.bindingCalled' && (params as { name?: string }).name === '__a11yClick' && testSession.a11yInspecting) {
        try {
          const { x, y } = JSON.parse((params as { payload?: string }).payload ?? '{}') as { x?: number; y?: number };
          if (typeof x === 'number' && typeof y === 'number') {
            (async () => {
              const dbg = view.webContents.debugger;
              const loc = await dbg.sendCommand('DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: false }) as { backendNodeId?: number };
              if (!loc.backendNodeId) return;
              const ax = await dbg.sendCommand('Accessibility.queryAXTree', { backendNodeId: loc.backendNodeId }) as { nodes?: unknown[] };
              const node = ax.nodes?.[0];
              if (node) this.win.webContents.send('a11y:nodeClicked', node);
            })().catch(() => {}); // silent: CDP event handler (a11y click binding) — too high-frequency to log
          }
        // silent: CDP event handler (a11y click binding) — too high-frequency to log
        } catch {}
        return;
      }
      if (method !== 'Fetch.requestPaused') return;
      const { requestId, request, networkId } = params as { requestId: string; request: { url: string; method: string }; networkId?: string };
      const dbg = view.webContents.debugger;
      // Safety cap (#210): a rule pattern that's broad in effect (e.g. '*ad*'
      // matching any URL containing "ad") can flood this handler with paused
      // requests the same way a literal '*' pattern used to, pre-#199, just
      // without _applyFetch()'s exact-string hasWildcard check catching it.
      // Past the cap, skip rule matching/tagging entirely and let the
      // request straight through, bounding worst-case load regardless of
      // pattern text.
      if (shouldRateLimitFetchPause(fetchPauseRateState, Date.now())) {
        dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {}); // silent: Fetch.requestPaused fires per request — too high-frequency to log
        return;
      }
      // Fetch.requestPaused's requestId is a Fetch-domain id, distinct from the
      // Network-domain requestId the recorder's Network.* events key off of —
      // tag the request under networkId (falling back to requestId when no
      // correlated network event exists) so the recorded response/failure
      // event actually carries the mock/resilience tag.
      const tagId = networkId || requestId;
      const mockRules = this.mockRulesByPartition.get(testSession.partition) ?? [];
      const rule = mockRules.find(r =>
        r.enabled && (r.method === '*' || r.method === request.method) && matchesGlob(r.urlPattern, request.url)
      );
      if (rule) {
        rule.hitCount = (rule.hitCount || 0) + 1;
        rule.lastHitAt = Date.now();
        testSession.recorder.tagRequest(tagId, { mockRuleId: rule.id });
        dbg.sendCommand('Fetch.fulfillRequest', { requestId, ...buildMockFulfillParams(rule) }).catch(() => {}); // silent: Fetch.requestPaused fires per request — too high-frequency to log
        return;
      }
      const resilienceRules = this.resilienceRulesByPartition.get(testSession.partition) ?? [];
      const res = resilienceRules.find(r => r.enabled && resilienceRuleMatchesRequest(r, request));
      if (res && Math.random() < res.probability) {
        res.hitCount = (res.hitCount || 0) + 1;
        res.lastHitAt = Date.now();
        testSession.recorder.tagRequest(tagId, { resilienceRuleId: res.id, resilienceType: res.type });
        // Every command below is silent: Fetch.requestPaused fires per
        // request, too high-frequency to log per failure (each case still
        // gets its own marker so the empty-catch triage grep is satisfied).
        switch (res.type) {
          case 'error500':
          case 'random500':
            dbg.sendCommand('Fetch.fulfillRequest', { requestId, responseCode: 500, body: Buffer.from('Internal Server Error').toString('base64') }).catch(() => {}); // silent: see comment above switch
            break;
          case 'timeout':
            dbg.sendCommand('Fetch.fulfillRequest', { requestId, responseCode: 504, body: Buffer.from('Gateway Timeout').toString('base64') }).catch(() => {}); // silent: see comment above switch
            break;
          case 'offline':
            dbg.sendCommand('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }).catch(() => {}); // silent: see comment above switch
            break;
          case 'missing':
            dbg.sendCommand('Fetch.fulfillRequest', { requestId, responseCode: 404, body: Buffer.from('Not Found').toString('base64') }).catch(() => {}); // silent: see comment above switch
            break;
          case 'corrupt':
            dbg.sendCommand('Fetch.fulfillRequest', { requestId, responseCode: 200, body: Buffer.from('\x00\x01\x02\xff\xfe' + 'x'.repeat(20)).toString('base64') }).catch(() => {}); // silent: see comment above switch
            break;
          case 'latency':
            setTimeout(() => {
              dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {}); // silent: see comment above switch
            }, res.latencyMs || 2000);
            break;
          default:
            dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {}); // silent: see comment above switch
        }
        return;
      }
      // Every branch above resolves the paused request via some Fetch.*
      // command, with rejections swallowed rather than left to hang — this
      // is deliberate, not just terseness: a page refresh (did-navigate)
      // cancels the outgoing document's in-flight loaders on Chromium's
      // side, including ones currently paused via the Fetch domain, so a
      // resolution command sent for a since-cancelled requestId is expected
      // to reject (the pause no longer exists to resolve) rather than hang
      // indefinitely (#210's acceptance criterion re: an unanswered paused
      // request surviving a refresh — investigated, no such path found: the
      // debugger itself is attached once per WebContentsView at creation and
      // stays attached across navigations, so there's no re-attach window
      // either).
      // silent: also fires per request, same as the branches above — too high-frequency to log
      dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {});
    });
    this.sessions.set(id, testSession);
    this.onSessionsChanged();
    // This tab's own CDP debugger has never had Fetch.enable called on it —
    // if the partition it was seeded for already has active mock/resilience
    // rules (reopen, "New tab in this session"), those rules should actually
    // intercept requests from this tab too, not just the tab that originally
    // added them.
    this._applyFetch(id);

    // webRequest allows one listener per event, so register it once per
    // partition and route by the requesting webContents.
    if (!this.hookedPartitions.has(partition)) {
      this.hookedPartitions.add(partition);
      ses.webRequest.onCompleted((details) => {
        try {
          const host = new URL(details.url).hostname;
          if (!host) return;
          for (const s of this.sessions.values()) {
            if (s.view.webContents.id === details.webContentsId) { s.loadedDomains.add(host); break; }
          }
        // silent: fires per completed network request — too high-frequency to log
        } catch {}
      });
    }

    if (opts.startUrl) {
      view.webContents.loadURL(opts.startUrl);
    } else {
      view.webContents.loadFile(NEWTAB_FILE);
    }

    view.webContents.on('did-navigate', (_e, url) => {
      const displayUrl = isNewtabUrl(url) ? '' : url;
      testSession.currentUrl = displayUrl;
      testSession.loadedDomains = new Set<string>();
      try { if (displayUrl) testSession.loadedDomains.add(new URL(displayUrl).hostname); } catch {} // silent: displayUrl is Electron's own just-navigated-to URL
      if (displayUrl) this.addHistoryEntry(id, displayUrl);
      this.win.webContents.send('session:navigated', { id, url: displayUrl });
      this.sendNavState(id);
      this.onSessionsChanged();
    });
    view.webContents.on('did-navigate-in-page', (_e, url) => {
      const displayUrl = isNewtabUrl(url) ? '' : url;
      testSession.currentUrl = displayUrl;
      if (displayUrl) this.addHistoryEntry(id, displayUrl);
      this.win.webContents.send('session:navigated', { id, url: displayUrl });
      this.sendNavState(id);
      this.onSessionsChanged();
    });
    view.webContents.on('page-title-updated', (_e, title) => {
      this.win.webContents.send('session:titleUpdated', { id, title });
    });
    view.webContents.on('page-favicon-updated', (_e, favicons) => {
      if (favicons[0]) this.win.webContents.send('session:faviconUpdated', { id, favicon: favicons[0] });
    });
    view.webContents.on('found-in-page', (_e, result) => {
      this.win.webContents.send('find:result', {
        id, matches: result.matches ?? 0, activeMatch: result.activeMatchOrdinal ?? 0,
      });
    });

    // Loading state
    view.webContents.on('did-start-loading', () => {
      this.win.webContents.send('session:loading', { id, loading: true });
    });
    view.webContents.on('did-stop-loading', () => {
      this.win.webContents.send('session:loading', { id, loading: false });
    });

    // Track DevTools open state via events — isDevToolsOpened() can lag behind
    // on slow runners because DevTools attaches asynchronously.
    view.webContents.on('devtools-opened', () => { testSession.devToolsOpen = true; });
    view.webContents.on('devtools-closed', () => { testSession.devToolsOpen = false; });

    // Navigation failure
    view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // ignore subframe failures and user-aborted
      if (validatedURL) this.addHistoryEntry(id, validatedURL, true);
      this.win.webContents.send('session:loadFailed', { id, errorCode, errorDescription, url: validatedURL });
      this.log.warn('sessions', `Main-frame load failed: ${errorDescription} (${errorCode})`, { sessionId: id });
    });

    // #227: unlike the chrome window's own render-process-gone/unresponsive
    // handlers in index.ts, nothing previously listened for a tab's own page
    // process dying or hanging — it just silently stopped responding.
    view.webContents.on('render-process-gone', (_e, details) => {
      this.log.error('sessions', `Tab render process gone: ${details.reason}`, { sessionId: id });
    });
    view.webContents.on('unresponsive', () => {
      this.log.error('sessions', 'Tab became unresponsive', { sessionId: id });
    });

    // Right-click context menu on page
    view.webContents.on('context-menu', (_e, params) => {
      const items: Electron.MenuItemConstructorOptions[] = [];

      if (params.linkURL) {
        items.push({ label: 'Open link in new tab', click: () => {
          if (!isSafeUrl(params.linkURL)) return;
          const ns = this.createSession(getHostname(params.linkURL), { partition, startUrl: params.linkURL, color });
          this.switchTo(ns.id);
          this.win.webContents.send('session:newTab', { id: ns.id });
        }});
        items.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
        items.push({ type: 'separator' });
      }

      if (params.mediaType === 'image' && params.srcURL) {
        items.push({ label: 'Open image in new tab', click: () => {
          if (!isSafeUrl(params.srcURL)) return;
          const ns = this.createSession('Image', { partition, startUrl: params.srcURL });
          this.switchTo(ns.id);
          this.win.webContents.send('session:newTab', { id: ns.id });
        }});
        items.push({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) });
        items.push({ type: 'separator' });
      }

      if (params.isEditable) {
        items.push({ label: 'Cut',        click: () => view.webContents.cut() });
        items.push({ label: 'Copy',       click: () => view.webContents.copy() });
        items.push({ label: 'Paste',      click: () => view.webContents.paste() });
        items.push({ label: 'Select All', click: () => view.webContents.selectAll() });
        const inject = (val: string) => this.injectTestData(view, val);
        items.push({
          label: 'Fill with test data',
          submenu: [
            { label: 'First name',   click: () => inject(genFirstName()) },
            { label: 'Last name',    click: () => inject(genLastName()) },
            { label: 'Full name',    click: () => inject(genFullName()) },
            { label: 'Email',        click: () => inject(genEmail()) },
            { type: 'separator' },
            { label: 'UUID',         click: () => inject(genUUID()) },
            { label: 'Date (today)', click: () => inject(genDate()) },
            { label: 'Phone',        click: () => inject(genPhone()) },
            { label: 'Address',      click: () => inject(genAddress()) },
            { type: 'separator' },
            { label: 'Custom template…', click: () => this.win.webContents.send('testdata:promptTemplate', { sessionId: id }) },
          ],
        });
        items.push({ type: 'separator' });
      } else if (params.selectionText) {
        items.push({ label: 'Copy', click: () => view.webContents.copy() });
        items.push({ type: 'separator' });
      }

      items.push({ label: 'Back',    enabled: view.webContents.canGoBack(),    click: () => view.webContents.goBack() });
      items.push({ label: 'Forward', enabled: view.webContents.canGoForward(), click: () => view.webContents.goForward() });
      items.push({ label: 'Reload',  click: () => view.webContents.reload() });
      items.push({ type: 'separator' });
      items.push({ label: 'Inspect Element', click: () => {
        if (!view.webContents.isDevToolsOpened()) view.webContents.openDevTools();
      }});

      Menu.buildFromTemplate(items).popup({ window: this.win });
    });

    view.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const { control: ctrl, shift, alt, key } = input;
      const send = (name: string) => { event.preventDefault(); this.win.webContents.send('app:shortcut', name); };

      if (ctrl && key === 'Tab')            { event.preventDefault(); this.win.webContents.send('tabs:cycle', { reverse: shift }); return; }
      if (ctrl && !shift && key === 't')    { send('newTab'); return; }
      if (ctrl && !shift && key === 'w')    { send('closeTab'); return; }
      if (ctrl && shift  && key === 'T')    { send('reopenTab'); return; }
      if (ctrl && key === 'l')              { send('focusUrl'); return; }
      if (ctrl && key === 'f')              { send('findToggle'); return; }
      if (ctrl && !shift && key === 'd')    { send('bookmark'); return; }
      if (ctrl && shift  && key === 'B')    { send('toggleBookmarksBar'); return; }
      if (key === 'F3')                     { send(shift ? 'findPrev' : 'findNext'); return; }
      if ((ctrl && key === 'r') || key === 'F5') { send('reload'); return; }
      if (key === 'Escape')                 { send('stopOrEsc'); return; }
      if (key === 'F12')                    { event.preventDefault(); this.toggleDevTools(this.activeId ?? ''); return; }
      if (ctrl && (key === '=' || key === '+')) { event.preventDefault(); this.setZoom(this.activeId ?? '', 0.1); return; }
      if (ctrl && key === '-')              { event.preventDefault(); this.setZoom(this.activeId ?? '', -0.1); return; }
      if (ctrl && key === '0')              { event.preventDefault(); this.resetZoom(this.activeId ?? ''); return; }
      if (alt && key === 'ArrowLeft')       { event.preventDefault(); this.back(this.activeId ?? ''); return; }
      if (alt && key === 'ArrowRight')      { event.preventDefault(); this.forward(this.activeId ?? ''); return; }
      // Ctrl+1–9 tab switching
      if (ctrl && key >= '1' && key <= '9') { send(`switchTab:${key}`); return; }
    });

    view.webContents.on('zoom-changed', (_event, zoomDirection) => {
      this.setZoom(id, zoomDirection === 'in' ? 0.1 : -0.1);
    });

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeUrl(url)) {
        setImmediate(() => {
          const newSession = this.createSession(getHostname(url), { partition, startUrl: url, color });
          this.switchTo(newSession.id);
          this.win.webContents.send('session:newTab', { id: newSession.id });
        });
      }
      return { action: 'deny' };
    });

    this.log.info('sessions', 'Session created', { sessionId: id });
    return testSession;
  }

  private sendNavState(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.win.webContents.send('session:navState', {
      id,
      canBack: s.view.webContents.canGoBack(),
      canForward: s.view.webContents.canGoForward(),
    });
  }

  // --- Download actions (delegated) ---

  listDownloads()       { return this.downloadManager.list(); }
  openDownload(id: string)   { this.downloadManager.open(id); }
  revealDownload(id: string) { this.downloadManager.reveal(id); }
  cancelDownload(id: string) { this.downloadManager.cancel(id); }
  clearDownloads()      { this.downloadManager.clear(); }

  // --- Permission (delegated) ---

  respondPermission(reqId: string, granted: boolean) { this.permissionManager.respond(reqId, granted); }

  // --- Session management ---

  renameSession(id: string, name: string) {
    const s = this.sessions.get(id);
    if (s) s.name = name.trim() || s.name;
  }

  pinSession(id: string, pinned: boolean) {
    const s = this.sessions.get(id);
    if (s) s.pinned = pinned;
  }

  back(id: string)    { this.sessions.get(id)?.view.webContents.goBack(); }
  forward(id: string) { this.sessions.get(id)?.view.webContents.goForward(); }
  reload(id: string)  { this.sessions.get(id)?.view.webContents.reload(); }
  stop(id: string)    { this.sessions.get(id)?.view.webContents.stop(); }

  setZoom(id: string, delta: number) {
    const s = this.sessions.get(id);
    if (!s) return;
    const cur = s.view.webContents.getZoomFactor();
    const next = Math.max(0.25, Math.min(5, Math.round((cur + delta) * 10) / 10));
    s.view.webContents.setZoomFactor(next);
    this.win.webContents.send('session:zoomChanged', { id, zoom: next });
  }

  resetZoom(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.view.webContents.setZoomFactor(1);
    this.win.webContents.send('session:zoomChanged', { id, zoom: 1 });
  }

  getZoom(id: string): number {
    return this.sessions.get(id)?.view.webContents.getZoomFactor() ?? 1;
  }

  toggleDevTools(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.devToolsOpen ? s.view.webContents.closeDevTools() : s.view.webContents.openDevTools();
  }

  findInPage(id: string, text: string, forward = true, findNext = false) {
    const s = this.sessions.get(id);
    if (!s || !text) return;
    s.view.webContents.findInPage(text, { forward, findNext });
  }
  stopFind(id: string) { this.sessions.get(id)?.view.webContents.stopFindInPage('clearSelection'); }

  setNotes(id: string, notes: string) { this.sessionNotes.set(id, notes); }
  getNotes(id: string) { return this.sessionNotes.get(id) ?? ''; }

  showContextMenu(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    const send = (action: string) => this.win.webContents.send('tab:action', { action, id });
    Menu.buildFromTemplate([
      { label: 'Rename',              click: () => send('rename') },
      { label: s.pinned ? 'Unpin' : 'Pin', click: () => {
        s.pinned = !s.pinned;
        this.win.webContents.send('tab:action', { action: 'refresh' });
      }},
      { type: 'separator' },
      { label: 'New tab in this session', click: () => {
        const ns = this.createSession(s.name, { partition: s.partition, color: s.color });
        this.switchTo(ns.id);
        this.win.webContents.send('session:newTab', { id: ns.id });
      }},
      { label: 'Clone', click: async () => {
        const c = await this.cloneSession(id, s.name + ' (clone)');
        if (c) this.win.webContents.send('session:newTab', { id: c.id });
      }},
      { label: 'Notes…', click: () => send('notes') },
      { label: 'History…', click: () => send('history') },
      { type: 'separator' },
      { label: 'Export snapshot…', click: () => this.exportSnapshotDialog(id) },
      { label: 'Import snapshot…', click: () => this.importSnapshotDialog(id) },
      { type: 'separator' },
      { label: 'Close', enabled: !s.pinned, click: () => send('close') },
    ]).popup({ window: this.win });
  }

  // --- Persist sessions across restarts ---

  private get sessionsFile() {
    return path.join(app.getPath('userData'), 'open-sessions.json');
  }

  // Called by the renderer whenever its tab strip order changes (drag-reorder,
  // new tab, close, restore) so saveSessions() can persist that order instead
  // of just the Map's creation-order iteration — see #102.
  setTabOrder(order: string[]) {
    this.tabOrder = order;
  }

  saveSessions() {
    try {
      const orderIndex = new Map(this.tabOrder.map((id, i) => [id, i]));
      const persistentSessions = Array.from(this.sessions.values()).filter(s => s.persistent);
      const sessions = persistentSessions
        .sort((a, b) => (orderIndex.get(a.id) ?? Infinity) - (orderIndex.get(b.id) ?? Infinity))
        .map(s => ({ name: s.name, partition: s.partition, url: s.currentUrl, color: s.color }));
      const notes: Record<string, string> = {};
      for (const [id, note] of this.sessionNotes) {
        const s = this.sessions.get(id);
        if (s && note) notes[s.partition] = note;
      }
      const emulation: Record<string, EmulationOverrides> = {};
      for (const s of persistentSessions) {
        if (s.emulation) emulation[s.partition] = s.emulation;
      }
      fs.writeFileSync(this.sessionsFile, JSON.stringify({ sessions, notes, emulation }));
    } catch (e) {
      this.log.warn('sessions', 'Failed to save sessions to disk', { error: String(e) });
    }
  }

  loadAndRestoreSessions(): boolean {
    try {
      if (!fs.existsSync(this.sessionsFile)) return false;
      const { sessions, notes, emulation } = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf-8'));
      if (!sessions?.length) return false;
      for (const s of sessions) {
        const sess = this.createSession(s.name, { partition: s.partition, startUrl: s.url, color: s.color });
        if (notes?.[s.partition]) this.sessionNotes.set(sess.id, notes[s.partition]);
        // Re-apply persisted overrides through setEmulation (not just record
        // them on s.emulation) so the CDP commands / date-offset script are
        // genuinely in force on the newly-created target, not merely
        // remembered by the panel.
        if (emulation?.[s.partition]) {
          this.setEmulation(sess.id, emulation[s.partition])
            .catch((e) => this.log.warn('sessions', 'Failed to restore emulation override on load', { sessionId: sess.id, error: String(e) }));
        }
      }
      const first = this.sessions.values().next().value as TestSession | undefined;
      if (first) this.switchTo(first.id);
      this.cleanupOldRecordings().catch(() => {}); // silent: cleanupOldRecordings() never rejects — its own try/catch below logs failures itself
      return true;
    } catch { return false; }
  }

  private async cleanupOldRecordings(maxAgeDays = 30) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const openIds = new Set(Array.from(this.sessions.keys()));
    try {
      const files = await fs.promises.readdir(this.dbDir);
      for (const f of files) {
        if (!f.endsWith('.sqlite')) continue;
        const sessionId = f.replace('.sqlite', '');
        if (openIds.has(sessionId)) continue;
        const fp = path.join(this.dbDir, f);
        try {
          const stat = await fs.promises.stat(fp);
          if (stat.mtimeMs < cutoff) await fs.promises.unlink(fp);
        // silent: stat/unlink race on one stale recording file among possibly many — not worth a warn per file
        } catch {}
      }
    } catch (e) {
      this.log.warn('sessions', 'Failed to clean up old recordings', { error: String(e) });
    }
  }

  // --- Layout ---

  switchTo(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (this.activeId) {
      const prev = this.sessions.get(this.activeId);
      if (prev) this.win.contentView.removeChildView(prev.view);
    }
    this.activeId = id;
    if (this.isViewVisible) {
      this.win.contentView.addChildView(s.view);
      this.layoutActive();
    }
    this.sendNavState(id);
    this.win.webContents.send('session:zoomChanged', { id, zoom: s.view.webContents.getZoomFactor() });
  }

  private layoutActive() {
    if (!this.activeId || !this.isViewVisible) return;
    const s = this.sessions.get(this.activeId);
    if (!s) return;
    s.view.setBounds(this.computeCaptureBounds());
  }

  private computeCaptureBounds() {
    const bounds = this.win.getContentBounds();
    const top = this.topBarHeight;
    return {
      x: 0,
      y: top,
      width: Math.max(0, bounds.width - this.rightPanelWidth),
      height: Math.max(0, bounds.height - top - this.consoleHeight),
    };
  }

  setConsoleHeight(height: number) {
    if (height === 0) {
      this.consoleHeight = 0;
    } else {
      // No floor here: the minimized header bar (42px) is a valid nonzero
      // height that's shorter than the drag-resize minimum (80px, enforced
      // by the renderer for manual resizing) — only cap the top end so the
      // console can't consume the whole window.
      const bounds = this.win.getContentBounds();
      const maxH = Math.max(80, bounds.height - this.topBarHeight - 80);
      this.consoleHeight = Math.max(0, Math.min(height, maxH));
    }
    this.layoutActive();
  }

  setTopBarHeight(height: number) {
    // Floor kept well below the merged titlebar+tabs row's real minimum
    // (~91px unadorned) so it only guards against a degenerate 0/negative
    // value from the renderer, never clamps the reclaimed layout space.
    this.topBarHeight = Math.max(60, height);
    this.layoutActive();
  }

  // Shrinks the active WebContentsView's width to make room for a fixed-position
  // HTML panel (e.g. the downloads panel) docked to the right edge of the window —
  // the view always paints on top of window HTML regardless of CSS z-index, so a
  // panel in that region needs the view's bounds narrowed rather than just a CSS toggle.
  setRightPanelWidth(width: number) {
    this.rightPanelWidth = Math.max(0, width);
    this.layoutActive();
  }

  // Snapshot-and-detach, for HTML overlays that extend below the topbar (e.g.
  // the View/app-menu dropdowns): the native view always paints over page HTML
  // regardless of z-index, so it can't simply sit under the dropdown. Capture
  // the page to an image the renderer paints in the view's place, then detach
  // the view entirely — the dropdown gets a real HTML stacking context to sit
  // above, and the page appears to stay put with zero reflow. Pair with
  // endPageOverlay() to reattach once the dropdown closes.
  async beginPageOverlay(): Promise<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } } | null> {
    if (!this.activeId || !this.isViewVisible) return null;
    const s = this.sessions.get(this.activeId);
    if (!s) return null;
    const bounds = this.computeCaptureBounds();
    const image = await s.view.webContents.capturePage();
    this.setViewerVisible(false);
    return { dataUrl: image.toDataURL(), bounds };
  }

  endPageOverlay() {
    this.setViewerVisible(true);
  }

  setViewerVisible(visible: boolean) {
    this.isViewVisible = visible;
    if (!this.activeId) return;
    const s = this.sessions.get(this.activeId);
    if (!s) return;
    if (visible) { this.win.contentView.addChildView(s.view); this.layoutActive(); }
    else { this.win.contentView.removeChildView(s.view); }
  }

  async cloneSession(sourceId: string, newName: string): Promise<TestSession | null> {
    const src = this.sessions.get(sourceId);
    if (!src) return null;
    const dest = this.createSession(newName, { persistent: src.persistent });
    // A clone is an independent copy of the source session as it currently
    // is — cookies below, and mock/resilience rules here, the same way.
    // createSession() already seeded dest.partition with []; overwrite with
    // a deep copy so editing either side afterward doesn't affect the other.
    this.mockRulesByPartition.set(dest.partition, structuredClone(this.mockRulesByPartition.get(src.partition) ?? []));
    this.resilienceRulesByPartition.set(dest.partition, structuredClone(this.resilienceRulesByPartition.get(src.partition) ?? []));
    // createSession() already called _applyFetch(dest.id) once, against the
    // empty rule set it seeded dest.partition with — re-apply now that the
    // copied rules above are in place, so the clone's own CDP debugger
    // actually gets Fetch.enable for them.
    this._applyFetch(dest.id);
    const cookies = await src.view.webContents.session.cookies.get({});
    for (const c of cookies) {
      const url = `${c.secure ? 'https' : 'http'}://${c.domain?.replace(/^\./, '')}${c.path}`;
      try {
        await dest.view.webContents.session.cookies.set({
          url, name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate,
        });
      } catch (e) {
        this.log.warn('sessions', `Failed to copy cookie '${c.name}' while cloning`, { sessionId: dest.id, error: String(e) });
      }
    }
    this.log.info('sessions', `Session cloned from ${sourceId}`, { sessionId: dest.id });
    return dest;
  }

  navigate(id: string, url: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.view.webContents.loadURL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  }

  getTimeline(id: string, opts?: { limit?: number; since?: number; sinceId?: number }) {
    return this.sessions.get(id)?.recorder.getTimeline(opts) ?? [];
  }

  getLoadedDomains(id: string): string[] {
    return Array.from(this.sessions.get(id)?.loadedDomains ?? []);
  }

  // ── Session snapshots ─────────────────────────────────────────────────────

  // Resolves once the frame either finishes loading, fails to load, or
  // timeoutMs elapses — whichever comes first — instead of the fixed delay
  // the old implementation used, which was either too short (subframes not
  // yet attached) or wastefully long depending on the page.
  private waitForFrameLoad(wc: Electron.WebContents, timeoutMs = 10000): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        wc.removeListener('did-finish-load', onLoad);
        wc.removeListener('did-fail-load', onFail);
        clearTimeout(timer);
        resolve();
      };
      const onLoad = () => finish();
      const onFail = () => finish();
      wc.once('did-finish-load', onLoad);
      wc.once('did-fail-load', onFail);
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  private async collectSnapshot(id: string): Promise<SessionSnapshot | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    const cookies = await s.view.webContents.session.cookies.get({});
    const warnings: string[] = [];
    const frames: FrameSnapshot[] = [];
    for (const frame of s.view.webContents.mainFrame.framesInSubtree) {
      try {
        const raw = (await frame.executeJavaScript(COLLECT_FRAME_SCRIPT)) as string;
        const parsed = JSON.parse(raw) as FrameSnapshot;
        frames.push(parsed);
        if (parsed.warnings?.length) warnings.push(...parsed.warnings.map((w) => `${parsed.url}: ${w}`));
      } catch (e) {
        warnings.push(`frame ${frame.url || '(unknown)'}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { version: 2, ts: Date.now(), sessionName: s.name, url: s.currentUrl, cookies, frames, warnings };
  }

  // Restores cookies, then per-frame storage/IndexedDB/history/scroll/form
  // state. Accepts both the current (version 2, multi-frame) shape and the
  // original version 1 shape (single implicit frame, storage inline) so
  // older exported snapshot files still import cleanly. Returns any
  // warnings collected along the way for the caller to surface.
  private async restoreSnapshot(id: string, snap: Record<string, unknown>): Promise<string[]> {
    const s = this.sessions.get(id);
    if (!s) return [];
    const warnings: string[] = [];

    if (Array.isArray(snap.cookies)) {
      await s.view.webContents.session.clearStorageData({ storages: ['cookies'] });
      for (const c of snap.cookies as Electron.Cookie[]) {
        const url = `${c.secure ? 'https' : 'http'}://${(c.domain ?? '').replace(/^\./, '')}${c.path ?? '/'}`;
        try {
          await s.view.webContents.session.cookies.set({ url, name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate });
        } catch (e) {
          warnings.push(`cookie ${c.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    const frames: FrameSnapshot[] = Array.isArray(snap.frames) && (snap.frames as unknown[]).length
      ? (snap.frames as FrameSnapshot[])
      : [{
          url: typeof snap.url === 'string' ? snap.url : '',
          localStorage: snap.localStorage as Record<string, string> | undefined,
          sessionStorage: snap.sessionStorage as Record<string, string> | undefined,
        }];
    const [mainFrameSnap, ...subframeSnaps] = frames;

    if (typeof snap.url === 'string' && snap.url) {
      await s.view.webContents.loadURL(snap.url);
      await this.waitForFrameLoad(s.view.webContents);
      // Same-page iframes start loading only after the main frame's load
      // event fires — give them a brief moment to attach before we walk
      // the frame tree below.
      await new Promise<void>((r) => setTimeout(r, 250));
    }

    const applyFrame = async (frame: Electron.WebFrameMain, snapFrame: FrameSnapshot | undefined) => {
      if (!snapFrame) return;
      try {
        const raw = (await frame.executeJavaScript(buildRestoreFrameScript(snapFrame))) as string;
        const parsed = JSON.parse(raw) as { warnings?: string[] };
        if (parsed.warnings?.length) warnings.push(...parsed.warnings.map((w) => `${snapFrame.url}: ${w}`));
      } catch (e) {
        warnings.push(`frame ${snapFrame.url}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    await applyFrame(s.view.webContents.mainFrame, mainFrameSnap);
    const remaining = [...subframeSnaps];
    const liveSubframes = s.view.webContents.mainFrame.framesInSubtree.filter((f) => f !== s.view.webContents.mainFrame);
    for (const liveFrame of liveSubframes) {
      const idx = remaining.findIndex((f) => f.url === liveFrame.url);
      if (idx < 0) continue;
      const [match] = remaining.splice(idx, 1);
      await applyFrame(liveFrame, match);
    }
    if (remaining.length) {
      warnings.push(`${remaining.length} captured frame(s) had no matching frame on restore (page structure changed)`);
    }
    if (frames.some((f) => f.reactState)) {
      warnings.push('Snapshot includes captured React state (diagnostic only) — component state is not restored on import.');
    }

    return warnings;
  }

  private showSnapshotWarnings(title: string, warnings: string[]): void {
    if (!warnings.length) return;
    dialog.showMessageBox(this.win, {
      type: 'warning',
      title,
      message: `Completed with ${warnings.length} warning(s):`,
      detail: warnings.slice(0, 20).join('\n') + (warnings.length > 20 ? `\n…and ${warnings.length - 20} more` : ''),
    });
  }

  async exportSnapshotDialog(id: string): Promise<void> {
    const snap = await this.collectSnapshot(id);
    if (!snap) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const result = await dialog.showSaveDialog(this.win, {
      title: 'Export session snapshot',
      defaultPath: `snapshot-${ts}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, JSON.stringify(snap, null, 2));
      this.showSnapshotWarnings('Export snapshot', snap.warnings);
      this.log.info('snapshot', 'Snapshot exported', { sessionId: id });
    }
  }

  async importSnapshotDialog(id: string): Promise<void> {
    const result = await dialog.showOpenDialog(this.win, {
      title: 'Import session snapshot',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return;
    const snap = this.readSnapshotFile(result.filePaths[0]);
    if (!snap) return;
    try {
      const warnings = await this.restoreSnapshot(id, snap);
      this.win.webContents.send('tab:action', { action: 'refresh' });
      this.showSnapshotWarnings('Import snapshot', warnings);
      this.log.info('snapshot', 'Snapshot imported', { sessionId: id });
    } catch (e) {
      dialog.showErrorBox('Import failed', 'Could not apply the session snapshot.');
      this.log.warn('snapshot', 'Snapshot import failed', { sessionId: id, error: String(e) });
    }
  }

  // Creates a brand-new session from an exported snapshot file, rather than
  // overwriting an existing tab — the entry point for File → Import session.
  async importSessionAsNewDialog(): Promise<void> {
    const result = await dialog.showOpenDialog(this.win, {
      title: 'Import session',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return;
    const snap = this.readSnapshotFile(result.filePaths[0]);
    if (!snap) return;
    const sessionName = typeof snap.sessionName === 'string' && snap.sessionName ? snap.sessionName : 'Imported session';
    const ns = this.createSession(sessionName);
    try {
      const warnings = await this.restoreSnapshot(ns.id, snap);
      this.switchTo(ns.id);
      this.win.webContents.send('session:newTab', { id: ns.id });
      this.showSnapshotWarnings('Import session', warnings);
    } catch {
      dialog.showErrorBox('Import failed', 'Could not apply the session snapshot.');
      this.destroySession(ns.id);
    }
  }

  // Reads and validates a snapshot file, showing an error dialog and
  // returning null if it's missing, malformed, or not shaped like a
  // snapshot. Accepts both version 1 (legacy, single implicit frame) and
  // version 2 (multi-frame) shapes.
  private readSnapshotFile(filePath: string): Record<string, unknown> | null {
    let snap: unknown;
    try {
      snap = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      dialog.showErrorBox('Import failed', 'The selected file is not valid JSON.');
      return null;
    }
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
      dialog.showErrorBox('Import failed', 'The selected file is not a valid session snapshot.');
      return null;
    }
    const s = snap as Record<string, unknown>;
    const looksValid = Array.isArray(s.frames) || Array.isArray(s.cookies) || typeof s.url === 'string';
    if (!looksValid) {
      dialog.showErrorBox('Import failed', 'The selected file is not a valid session snapshot.');
      return null;
    }
    return s;
  }

  // ─────────────────────────────────────────────────────────────────────────

  private injectTestData(view: WebContentsView, value: string) {
    const escaped = JSON.stringify(value);
    view.webContents.executeJavaScript(`
      (function(){
        var el=document.activeElement;
        if(!el||!('value' in el))return;
        el.value=${escaped};
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
      })();
    `).catch((e) => this.log.warn('sessions', 'Failed to inject test data', { error: String(e) }));
  }

  applyTemplate(id: string, template: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.injectTestData(s.view, resolveTemplate(template));
  }

  async setEmulation(id: string, opts: { timezone?: string; locale?: string; latitude?: number; longitude?: number; accuracy?: number; timeOffsetMs?: number; userAgent?: string; clear?: boolean }): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    const dbg = s.view.webContents.debugger;
    if (opts.clear) {
      await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: '' }).catch((e) => this.warnCdpFailure(id, 'Emulation.setTimezoneOverride', e));
      await dbg.sendCommand('Emulation.setLocaleOverride', { locale: '' }).catch((e) => this.warnCdpFailure(id, 'Emulation.setLocaleOverride', e));
      await dbg.sendCommand('Emulation.clearGeolocationOverride').catch((e) => this.warnCdpFailure(id, 'Emulation.clearGeolocationOverride', e));
      s.view.webContents.setUserAgent(s.defaultUserAgent);
      await dbg.sendCommand('Emulation.setUserAgentOverride', { userAgent: s.defaultUserAgent }).catch((e) => this.warnCdpFailure(id, 'Emulation.setUserAgentOverride', e));
      const existingScriptId = this.dateOverrideScripts.get(id);
      if (existingScriptId) {
        await dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: existingScriptId }).catch((e) => this.warnCdpFailure(id, 'Page.removeScriptToEvaluateOnNewDocument', e));
        this.dateOverrideScripts.delete(id);
      }
      s.emulation = null;
      return;
    }
    const applied: EmulationOverrides = { ...(s.emulation ?? {}) };
    if (opts.timezone !== undefined) {
      await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: opts.timezone }).catch((e) => this.warnCdpFailure(id, 'Emulation.setTimezoneOverride', e));
      applied.timezone = opts.timezone;
    }
    if (opts.locale !== undefined) {
      await dbg.sendCommand('Emulation.setLocaleOverride', { locale: opts.locale }).catch((e) => this.warnCdpFailure(id, 'Emulation.setLocaleOverride', e));
      applied.locale = opts.locale;
    }
    if (opts.latitude !== undefined && opts.longitude !== undefined) {
      await dbg.sendCommand('Emulation.setGeolocationOverride', { latitude: opts.latitude, longitude: opts.longitude, accuracy: opts.accuracy ?? 10 }).catch((e) => this.warnCdpFailure(id, 'Emulation.setGeolocationOverride', e));
      applied.latitude = opts.latitude;
      applied.longitude = opts.longitude;
    }
    if (opts.userAgent !== undefined) {
      // An explicit empty string (the field cleared, then Apply) means
      // "restore the default UA", not "leave it unchanged" — unlike the
      // other fields, this one has an explicit clear-via-Apply acceptance
      // criterion, not just the Reset button above.
      if (opts.userAgent === '') {
        s.view.webContents.setUserAgent(s.defaultUserAgent);
        await dbg.sendCommand('Emulation.setUserAgentOverride', { userAgent: s.defaultUserAgent }).catch((e) => this.warnCdpFailure(id, 'Emulation.setUserAgentOverride', e));
        delete applied.userAgent;
      } else {
        s.view.webContents.setUserAgent(opts.userAgent);
        await dbg.sendCommand('Emulation.setUserAgentOverride', {
          userAgent: opts.userAgent,
          userAgentMetadata: buildUserAgentMetadata(opts.userAgent),
        }).catch((e) => this.warnCdpFailure(id, 'Emulation.setUserAgentOverride', e));
        applied.userAgent = opts.userAgent;
      }
    }
    if (opts.timeOffsetMs !== undefined) {
      const existingScriptId = this.dateOverrideScripts.get(id);
      if (existingScriptId) {
        await dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: existingScriptId }).catch((e) => this.warnCdpFailure(id, 'Page.removeScriptToEvaluateOnNewDocument', e));
        this.dateOverrideScripts.delete(id);
      }
      await dbg.sendCommand('Page.enable').catch((e) => this.warnCdpFailure(id, 'Page.enable', e));
      // The CDP command occasionally fails transiently under system load
      // (observed in CI) — retry once before giving up, and only report the
      // offset as applied if the script genuinely got registered, so the UI
      // never claims an override is active when it silently isn't.
      let result: { identifier: string } | null = null;
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        result = await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: buildDateOverrideScript(opts.timeOffsetMs),
        }).catch(() => null) as { identifier: string } | null;
      }
      if (result?.identifier) {
        this.dateOverrideScripts.set(id, result.identifier);
        applied.timeOffsetMs = opts.timeOffsetMs;
      } else {
        this.log.error('sessions', 'Failed to apply clock offset override', { sessionId: id });
      }
    }
    s.emulation = applied;
  }

  getEmulation(id: string): EmulationOverrides | null {
    return this.sessions.get(id)?.emulation ?? null;
  }

  private addHistoryEntry(id: string, url: string, failed = false) {
    const list = this.sessionHistory.get(id) ?? [];
    const last = list[list.length - 1];
    if (last && last.url === url && !failed) return; // collapse consecutive duplicates
    list.push({ url, ts: Date.now(), failed });
    this.sessionHistory.set(id, list);
  }

  // Newest first, matching how a browser's history list is normally read.
  getHistory(id: string): HistoryEntry[] {
    return [...(this.sessionHistory.get(id) ?? [])].reverse();
  }

  // newtab.html renders in its own WebContentsView, out of reach of the app
  // shell's light-mode class, so the chosen theme is pushed to each view.
  broadcastTheme(theme: string) {
    for (const s of this.sessions.values()) {
      s.view.webContents.send('theme:changed', theme);
    }
  }

  async captureScreenshot(id: string, opts?: { fullPage?: boolean }): Promise<string | null> {
    const s = this.sessions.get(id);
    if (!s) return null;

    // A WebContentsView not currently attached to the window (any session
    // other than the active tab — switchTo() detaches every inactive
    // session's view) won't composite frames, so Page.captureScreenshot
    // can hang indefinitely on it. Mount it behind the active view just
    // long enough to capture — it renders below whatever tab is actually
    // showing, so it's invisible to the user — then detach it again
    // afterward, leaving switchTo()'s own bookkeeping untouched. This is
    // what makes comparing a baseline against a *different* session's
    // current screenshot possible — see #127.
    const isAttached = id === this.activeId;
    if (!isAttached) {
      s.view.setBounds(this.computeCaptureBounds());
      this.win.contentView.addChildView(s.view, 0);
    }

    const dbg = s.view.webContents.debugger;
    try {
      if (!opts?.fullPage) {
        const result = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' }) as { data: string };
        return result.data ?? null;
      }

      const metrics = await dbg.sendCommand('Page.getLayoutMetrics') as {
        cssContentSize?: { width: number; height: number };
        contentSize?:    { width: number; height: number };
      };
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (!size) {
        const result = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' }) as { data: string };
        return result.data ?? null;
      }

      // Chromium cannot allocate a capture texture larger than 16384px per side.
      const width  = Math.min(Math.ceil(size.width),  MAX_CAPTURE_PX);
      const height = Math.min(Math.ceil(size.height), MAX_CAPTURE_PX);
      const result = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      }) as { data: string };
      return result.data ?? null;
    } catch {
      return null;
    } finally {
      if (!isAttached) this.win.contentView.removeChildView(s.view);
    }
  }

  // Captures the TesterBrowser chrome itself (topbar, console panel) for bug
  // reports — win.webContents is the app's own renderer, a separate compositing
  // layer from the child WebContentsView that shows the site under test, so this
  // never includes page content.
  async captureAppScreenshot(): Promise<string | null> {
    try {
      const img = await this.win.webContents.capturePage();
      // Keep the upload comfortably under GitHub's Contents API size limit for
      // embedding in bug reports — a full-resolution PNG of the whole window can
      // easily run past 1MB, especially at high DPI, and silently fail to attach.
      const resized = img.getSize().width > 1400 ? img.resize({ width: 1400 }) : img;
      return resized.toJPEG(80).toString('base64');
    } catch { return null; }
  }

  async getA11yTree(id: string): Promise<object[] | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    const dbg = s.view.webContents.debugger;
    try {
      await dbg.sendCommand('Accessibility.enable');
      const result = await dbg.sendCommand('Accessibility.getFullAXTree') as { nodes?: object[] };
      return result.nodes ?? [];
    } catch {
      return null;
    }
  }

  async setA11yInspect(id: string, enabled: boolean): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.a11yInspecting = enabled;
    const dbg = s.view.webContents.debugger;
    if (enabled) {
      try {
        await dbg.sendCommand('Accessibility.enable');
        await dbg.sendCommand('Runtime.addBinding', { name: '__a11yHover' });
        await dbg.sendCommand('Runtime.addBinding', { name: '__a11yClick' });
        await dbg.sendCommand('Runtime.evaluate', {
          expression: `(function(){if(window.__a11yHoverSetup)return;window.__a11yHoverSetup=true;let t=0;document.addEventListener('mousemove',function(e){const n=Date.now();if(n-t<150)return;t=n;window.__a11yHover(JSON.stringify({x:Math.round(e.clientX),y:Math.round(e.clientY)}));},{passive:true});document.addEventListener('click',function(e){if(!window.__a11yHoverSetup)return;e.preventDefault();e.stopPropagation();window.__a11yClick(JSON.stringify({x:Math.round(e.clientX),y:Math.round(e.clientY)}));},{capture:true});})();`,
          includeCommandLineAPI: false,
        });
      } catch (e) {
        this.log.warn('sessions', 'Failed to enable a11y inspect bindings', { sessionId: id, error: String(e) });
      }
    } else {
      try {
        await dbg.sendCommand('Runtime.evaluate', {
          expression: `window.__a11yHoverSetup=false;`,
          includeCommandLineAPI: false,
        });
        await dbg.sendCommand('Runtime.removeBinding', { name: '__a11yHover' });
        await dbg.sendCommand('Runtime.removeBinding', { name: '__a11yClick' });
      } catch (e) {
        this.log.warn('sessions', 'Failed to disable a11y inspect bindings', { sessionId: id, error: String(e) });
      }
    }
  }

  // Modeled on setA11yInspect above, but unlike Inspect element's live
  // hover/click bindings, this doesn't need a Runtime.addBinding round trip:
  // the whole scan (tab order + focus/style diff) runs synchronously in one
  // Runtime.evaluate and its result is the list itself.
  async setA11yFocusOverlay(id: string, enabled: boolean): Promise<FocusOrderItem[] | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.a11yFocusOverlayOn = enabled;
    const dbg = s.view.webContents.debugger;
    if (!enabled) {
      try {
        await dbg.sendCommand('Runtime.evaluate', { expression: FOCUS_OVERLAY_DISABLE_SCRIPT, includeCommandLineAPI: false });
      } catch (e) {
        this.log.warn('sessions', 'Failed to disable a11y focus overlay', { sessionId: id, error: String(e) });
      }
      return null;
    }
    try {
      const result = await dbg.sendCommand('Runtime.evaluate', {
        expression: FOCUS_OVERLAY_ENABLE_SCRIPT,
        returnByValue: true,
      }) as { result?: { value?: string }; exceptionDetails?: unknown };
      if (result.exceptionDetails || typeof result.result?.value !== 'string') return null;
      return JSON.parse(result.result.value) as FocusOrderItem[];
    } catch {
      return null;
    }
  }

  // Dispatches a trusted Tab/Shift+Tab key press through CDP, exactly as a
  // real keyboard would — unlike a page-side dispatchEvent(new
  // KeyboardEvent(...)), this is untrusted and neither advances native
  // focus nor reaches a listener's preventDefault() the way a real Tab
  // press would, which is the whole point of this check (catching a
  // handler that intercepts the real event to build a trap).
  private async dispatchTabKey(dbg: Electron.Debugger, shift: boolean): Promise<void> {
    const modifiers = shift ? 8 : 0; // CDP Input modifiers bitmask: Shift=8
    const common = { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers };
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }

  private async readActiveElement(s: TestSession): Promise<string> {
    try {
      return await s.view.webContents.executeJavaScript(READ_ACTIVE_ELEMENT_SCRIPT) as string;
    } catch {
      return '';
    }
  }

  private async focusElementBySelector(s: TestSession, selector: string): Promise<void> {
    try {
      await s.view.webContents.executeJavaScript(`
        (function(sel) {
          var el = document.querySelector(sel);
          if (el) el.focus({ preventScroll: true });
        })(${JSON.stringify(selector)})
      `);
    } catch (e) {
      this.log.warn('sessions', 'Failed to focus element by selector for focus-trap check', { sessionId: s.id, error: String(e) });
    }
  }

  // Walks forward (or, in reverse, Shift+Tab backward) for up to 2×N steps,
  // reading document.activeElement between each dispatched key so a broken
  // handler that preventDefault()s the real Tab keydown shows up as the
  // active element simply never advancing. Stops early once the same
  // element is observed twice in a row — a self-stall that classify below
  // would report as a dead end regardless, so there's no point spending the
  // remaining CDP round trips confirming it further.
  private async walkFocusTrap(
    s: TestSession, dbg: Electron.Debugger, n: number, reverse: boolean, expectedTerminal: string
  ): Promise<FocusTrapDirectionResult> {
    const maxSteps = 2 * n;
    const sequence: string[] = [];
    // The starting focus position (unfocused for a forward walk, the last
    // element for a reverse one) is set up by the caller before this runs.
    let prevDescriptor: string | null = null;
    for (let step = 0; step < maxSteps; step++) {
      await this.dispatchTabKey(dbg, reverse);
      const descriptor = await this.readActiveElement(s);
      sequence.push(descriptor);
      if (descriptor === prevDescriptor) break; // stopped changing — a dead end classify() will report
      prevDescriptor = descriptor;
    }
    return classifyFocusTrapSequence(sequence, expectedTerminal);
  }

  async detectA11yFocusTrap(id: string): Promise<FocusTrapResult | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    const dbg = s.view.webContents.debugger;
    try {
      const raw = await s.view.webContents.executeJavaScript(FOCUS_CANDIDATES_LIST_SCRIPT) as string;
      const selectors = JSON.parse(raw) as string[];
      const n = selectors.length;
      const empty: FocusTrapDirectionResult = { passed: true, kind: 'pass', trappedElements: [], sequence: [] };
      if (n === 0) return { forward: empty, backward: empty };

      try { await s.view.webContents.executeJavaScript('document.activeElement && document.activeElement.blur();'); } catch {} // silent: best-effort blur reset — nothing focused is a normal, expected case
      // Walk with index-based terminals so classifyFocusTrapSequence compares
      // unique identifiers — READ_ACTIVE_ELEMENT_SCRIPT returns the element's
      // position index from window.__a11yTrapEls, not its CSS selector, so two
      // elements sharing the same tag/no-id string can't collide.
      const forward = await this.walkFocusTrap(s, dbg, n, false, String(n - 1));

      await this.focusElementBySelector(s, selectors[n - 1]);
      const backward = await this.walkFocusTrap(s, dbg, n, true, '0');

      // Map positional indices in the result back to human-readable selectors.
      const idxToSel = (v: string) => {
        const i = Number(v);
        return Number.isInteger(i) && i >= 0 && i < n ? selectors[i] : v;
      };
      const mapResult = (r: FocusTrapDirectionResult): FocusTrapDirectionResult => ({
        ...r,
        trappedElements: r.trappedElements.map(idxToSel),
        sequence: r.sequence.map(idxToSel),
      });
      return { forward: mapResult(forward), backward: mapResult(backward) };
    } catch {
      return null;
    }
  }

  // Vendored under renderer/ (rather than read from node_modules/axe-core at
  // runtime) so the packaged NSIS build is guaranteed to contain it — that
  // directory is unambiguously covered by build.files' `renderer/**/*` entry,
  // unlike node_modules, whose inclusion for a given production dependency
  // isn't something to assume without confirming the actual packaged build.
  private getAxeSource(): string {
    if (this.axeSource === null) {
      try {
        this.axeSource = fs.readFileSync(
          path.join(__dirname, '..', '..', 'renderer', 'vendor', 'axe.min.js'), 'utf8'
        );
      } catch {
        this.axeSource = '';
      }
    }
    return this.axeSource;
  }

  async getA11yViolations(id: string): Promise<A11yViolationsResult> {
    const s = this.sessions.get(id);
    if (!s) {
      const error = `No such session: ${id}`;
      this.log.error('sessions', `A11y violations audit failed: ${error}`, { sessionId: id });
      return { ok: false, error };
    }
    const axeSource = this.getAxeSource();
    if (!axeSource) {
      const error = 'axe-core bundle could not be loaded';
      this.log.error('sessions', `A11y violations audit failed: ${error}`, { sessionId: id });
      return { ok: false, error };
    }
    const dbg = s.view.webContents.debugger;
    try {
      // Same isolated-world-free injection technique as setA11yInspect's
      // hover/click bindings above: run axe-core directly in the page's own
      // main world, since it needs to read live computed styles/DOM state.
      await dbg.sendCommand('Runtime.evaluate', { expression: axeSource, includeCommandLineAPI: false });
      // Wrapped in an async IIFE rather than a bare top-level `await` — CDP's
      // Runtime.evaluate treats the expression as an ordinary (non-module,
      // non-REPL) script, where a top-level `await` is a SyntaxError; the
      // exception it throws was being silently swallowed into an empty
      // violations list below. An async IIFE's own returned promise is what
      // awaitPromise actually awaits, which is the portable way to run async
      // code through this API regardless of REPL-mode support.
      const runExpression =
        `(async () => JSON.stringify((await axe.run(document, { rules: ${JSON.stringify(buildAxeRuleConfig())} })).violations))()`;
      const result = await dbg.sendCommand('Runtime.evaluate', {
        expression: runExpression,
        awaitPromise: true,
        returnByValue: true,
      }) as { result?: { value?: string }; exceptionDetails?: A11yExceptionDetails };
      if (result.exceptionDetails) {
        const error = result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text
          ?? 'axe-core threw while running in the page';
        this.log.error('sessions', `A11y violations audit failed: ${error}`, { sessionId: id });
        return { ok: false, error };
      }
      if (typeof result.result?.value !== 'string') {
        const error = 'axe-core returned no result';
        this.log.error('sessions', `A11y violations audit failed: ${error}`, { sessionId: id });
        return { ok: false, error };
      }
      return { ok: true, violations: JSON.parse(result.result.value) };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log.error('sessions', `A11y violations audit failed: ${error}`, { sessionId: id });
      return { ok: false, error };
    }
  }

  // Scrolls to and briefly outlines the element a violation node points at.
  // Selector comes from axe's own `target` array — single-frame, single-
  // selector targets only (see renderer/a11y.js for the multi-frame/shadow-
  // DOM cases this deliberately doesn't handle).
  async highlightA11yElement(id: string, selector: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    try {
      return await s.view.webContents.executeJavaScript(`
        (function(sel) {
          try {
            const el = document.querySelector(sel);
            if (!el) return false;
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el.style.outline = '3px solid #ff5252';
            el.style.outlineOffset = '2px';
            setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 2000);
            return true;
          } catch { return false; }
        })(${JSON.stringify(selector)})
      `);
    } catch {
      return false;
    }
  }

  async getContrastIssues(id: string): Promise<ContrastIssue[] | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    try {
      const raw = await s.view.webContents.executeJavaScript(CONTRAST_SCAN_SCRIPT) as string;
      const entries = JSON.parse(raw) as RawContrastEntry[];
      const results: ContrastIssue[] = [];
      for (const entry of entries) {
        const base = {
          selector: entry.selector,
          text: entry.text,
          color: entry.color,
          backgroundColor: entry.backgroundColor,
        };
        if (entry.backgroundImage) {
          results.push({ ...base, ratio: null, threshold: null, isLarge: false, status: 'unknown-background' });
          continue;
        }
        const fg: RGB | null = parseCssColor(entry.color);
        const bg: RGB | null = parseCssColor(entry.backgroundColor);
        if (!fg || !bg) continue;
        const large = isLargeText(entry.fontSize, entry.fontWeight);
        const ratio = contrastRatio(fg, bg);
        const aaThreshold = large ? WCAG_AA_LARGE : WCAG_AA_NORMAL;
        const aaaThreshold = large ? WCAG_AAA_LARGE : WCAG_AAA_NORMAL;
        if (ratio < aaThreshold) {
          results.push({ ...base, ratio, threshold: aaThreshold, isLarge: large, status: 'aa-fail' });
        } else if (ratio < aaaThreshold) {
          results.push({ ...base, ratio, threshold: aaaThreshold, isLarge: large, status: 'aaa-note' });
        }
      }
      return results;
    } catch {
      return null;
    }
  }

  // Highlights an AX node by its backendDOMNodeId (present on every CDP
  // Accessibility.AXNode) — used by the Structure view, which works from
  // whatever the accessibility tree already carries rather than resolving a
  // CSS selector, so it doesn't depend on the Tree view having been opened.
  async highlightA11yNode(id: string, backendDOMNodeId: number): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    const dbg = s.view.webContents.debugger;
    try {
      await dbg.sendCommand('DOM.enable');
      await dbg.sendCommand('Overlay.enable');
      await dbg.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId: backendDOMNodeId });
      await dbg.sendCommand('Overlay.highlightNode', {
        backendNodeId: backendDOMNodeId,
        highlightConfig: {
          showInfo: true,
          contentColor: { r: 255, g: 82, b: 82, a: 0.3 },
          borderColor: { r: 255, g: 82, b: 82, a: 0.8 },
        },
      });
      // silent: best-effort highlight cleanup after a 2s delay — the session may already be gone by then
      setTimeout(() => { dbg.sendCommand('Overlay.hideHighlight').catch(() => {}); }, 2000);
      return true;
    } catch {
      return false;
    }
  }

  async getAltLabelIssues(id: string): Promise<AltLabelIssues | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    try {
      const raw = await s.view.webContents.executeJavaScript(ALT_LABEL_SCAN_SCRIPT) as string;
      return JSON.parse(raw) as AltLabelIssues;
    } catch {
      return null;
    }
  }

  async getCookies(id: string) {
    const s = this.sessions.get(id);
    if (!s) return [];
    return s.view.webContents.session.cookies.get({});
  }

  async setCookie(id: string, details: Electron.CookiesSetDetails): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.view.webContents.session.cookies.set(details);
  }

  async getLocalStorage(id: string): Promise<Record<string, string>> {
    const s = this.sessions.get(id);
    if (!s) return {};
    try {
      const raw = await s.view.webContents.executeJavaScript(
        'JSON.stringify(Object.fromEntries(Object.entries(localStorage)))'
      );
      return JSON.parse(raw) ?? {};
    } catch { return {}; }
  }

  async deleteCookie(id: string, name: string, domain: string, cookiePath: string, secure: boolean): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    const host = domain.replace(/^\./, '');
    const url = `${secure ? 'https' : 'http'}://${host}${cookiePath || '/'}`;
    await s.view.webContents.session.cookies.remove(url, name)
      .catch((e) => this.log.warn('sessions', `Failed to delete cookie '${name}'`, { sessionId: id, error: String(e) }));
  }

  async clearCookies(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    const cookies = await s.view.webContents.session.cookies.get({});
    await Promise.all(cookies.map(c => {
      const host = (c.domain ?? '').replace(/^\./, '');
      const url = `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`;
      return s.view.webContents.session.cookies.remove(url, c.name)
        .catch((e) => this.log.warn('sessions', `Failed to clear cookie '${c.name}'`, { sessionId: id, error: String(e) }));
    }));
  }

  async deleteLocalStorageKey(id: string, key: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.view.webContents.executeJavaScript(
      `void localStorage.removeItem(${JSON.stringify(key)})`
    ).catch((e) => this.log.warn('sessions', `Failed to delete localStorage key '${key}'`, { sessionId: id, error: String(e) }));
  }

  async setLocalStorageKey(id: string, key: string, value: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.view.webContents.executeJavaScript(
      `void localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`
    ).catch((e) => this.log.warn('sessions', `Failed to set localStorage key '${key}'`, { sessionId: id, error: String(e) }));
  }

  async clearLocalStorage(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.view.webContents.executeJavaScript('void localStorage.clear()')
      .catch((e) => this.log.warn('sessions', 'Failed to clear localStorage', { sessionId: id, error: String(e) }));
  }

  // Mock/Resilience rules live in mockRulesByPartition/resilienceRulesByPartition
  // (see field comment), keyed by the session's stable partition rather than
  // the per-tab id these methods still take from the renderer — these two
  // resolve id → partition once so every method below reads/writes the one
  // rule set shared by every tab open on that partition.
  private mockRulesForId(id: string): MockRule[] | null {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return null;
    let rules = this.mockRulesByPartition.get(partition);
    if (!rules) { rules = []; this.mockRulesByPartition.set(partition, rules); }
    return rules;
  }

  private resilienceRulesForId(id: string): ResilienceRule[] | null {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return null;
    let rules = this.resilienceRulesByPartition.get(partition);
    if (!rules) { rules = []; this.resilienceRulesByPartition.set(partition, rules); }
    return rules;
  }

  getMockRules(id: string): MockRule[] {
    return this.mockRulesForId(id) ?? [];
  }

  addMockRule(id: string, rule: MockRule): void {
    const rules = this.mockRulesForId(id);
    if (!rules) return;
    rules.push({ ...rule, responseHeaders: rule.responseHeaders || {}, hitCount: 0, lastHitAt: null });
    this._applyMocks(id);
    this.log.info('mock', `Mock rule added: ${rule.method} ${rule.urlPattern}`, { sessionId: id });
  }

  removeMockRule(id: string, ruleId: string): void {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return;
    const rules = (this.mockRulesByPartition.get(partition) ?? []).filter(r => r.id !== ruleId);
    this.mockRulesByPartition.set(partition, rules);
    this._applyMocks(id);
    this.log.info('mock', `Mock rule removed: ${ruleId}`, { sessionId: id });
  }

  toggleMockRule(id: string, ruleId: string, enabled: boolean): void {
    const rules = this.mockRulesForId(id);
    if (!rules) return;
    const rule = rules.find(r => r.id === ruleId);
    if (rule) rule.enabled = enabled;
    this._applyMocks(id);
    this.log.info('mock', `Mock rule ${enabled ? 'enabled' : 'disabled'}: ${ruleId}`, { sessionId: id });
  }

  // A ruleId that doesn't match any rule is a no-op (nothing to update,
  // nothing to re-apply).
  updateMockRule(id: string, ruleId: string, patch: Partial<MockRule>): void {
    const rules = this.mockRulesForId(id);
    if (!rules) return;
    const idx = rules.findIndex(r => r.id === ruleId);
    if (idx === -1) return;
    rules[idx] = applyMockRulePatch(rules[idx], patch);
    this._applyMocks(id);
  }

  private _applyFetch(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const dbg = s.view.webContents.debugger;
    const activeMocks = (this.mockRulesByPartition.get(s.partition) ?? []).filter(r => r.enabled);
    const activeRes = (this.resilienceRulesByPartition.get(s.partition) ?? []).filter(r => r.enabled);
    if (activeMocks.length === 0 && activeRes.length === 0) {
      dbg.sendCommand('Fetch.disable').catch((e) => this.warnCdpFailure(id, 'Fetch.disable', e));
    } else {
      // Use the rules' own URL patterns so Chromium only sends Fetch.requestPaused
      // for matching requests. Previously, any active resilience rule forced urlPattern:'*',
      // intercepting every resource on ad-heavy sites and causing CDP channel overload.
      const patterns: { urlPattern: string; requestStage: 'Request' }[] = [
        ...activeMocks.map(r => ({ urlPattern: r.urlPattern, requestStage: 'Request' as const })),
        ...activeRes.map(r => ({ urlPattern: r.urlPattern, requestStage: 'Request' as const })),
      ];
      const hasWildcard = patterns.some(p => p.urlPattern === '*' || p.urlPattern === '');
      dbg.sendCommand('Fetch.enable', {
        patterns: hasWildcard
          ? [{ urlPattern: '*', requestStage: 'Request' }]
          : patterns,
      }).catch((e) => this.warnCdpFailure(id, 'Fetch.enable', e));
    }
  }

  /** @deprecated use _applyFetch */
  private _applyMocks(id: string): void { this._applyFetch(id); }

  getResilienceRules(id: string): ResilienceRule[] {
    return this.resilienceRulesForId(id) ?? [];
  }

  addResilienceRule(id: string, rule: ResilienceRule): void {
    const rules = this.resilienceRulesForId(id);
    if (!rules) return;
    rules.push({ ...rule, method: rule.method || '*', hitCount: 0, lastHitAt: null });
    this._applyFetch(id);
    this.log.info('resilience', `Resilience rule added: ${rule.urlPattern}`, { sessionId: id });
  }

  removeResilienceRule(id: string, ruleId: string): void {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return;
    const rules = (this.resilienceRulesByPartition.get(partition) ?? []).filter(r => r.id !== ruleId);
    this.resilienceRulesByPartition.set(partition, rules);
    this._applyFetch(id);
    this.log.info('resilience', `Resilience rule removed: ${ruleId}`, { sessionId: id });
  }

  toggleResilienceRule(id: string, ruleId: string, enabled: boolean): void {
    const rules = this.resilienceRulesForId(id);
    if (!rules) return;
    const rule = rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = enabled;
      this._applyFetch(id);
      this.log.info('resilience', `Resilience rule ${enabled ? 'enabled' : 'disabled'}: ${ruleId}`, { sessionId: id });
    }
  }

  updateResilienceRule(id: string, ruleId: string, patch: Partial<ResilienceRule>): void {
    const rules = this.resilienceRulesForId(id);
    if (!rules) return;
    const rule = rules.find(r => r.id === ruleId);
    if (rule) { Object.assign(rule, patch); this._applyFetch(id); }
  }

  destroySession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const leaderId of Array.from(this.followPairings.keys())) {
      const p = this.followPairings.get(leaderId);
      if (p && (p.leaderId === id || p.followerId === id)) {
        this.stopFollowAlong(leaderId)
          .catch((e) => this.log.warn('sessions', 'Failed to stop Follow Along pairing during session destroy', { sessionId: id, error: String(e) }));
      }
    }
    if (this.activeId === id) { this.win.contentView.removeChildView(s.view); this.activeId = null; }
    s.recorder.destroy();
    (s.view.webContents as any).destroy?.();
    this.sessions.delete(id);
    this.sessionNotes.delete(id);
    this.recordingHandlers.delete(id);
    this.recordingBuffers.delete(id);
    this.dateOverrideScripts.delete(id);
    this.sessionHistory.delete(id);
    this.onSessionsChanged();
    this.log.info('sessions', 'Session destroyed', { sessionId: id });
  }

  // Reads the page's live in-progress steps and merges them (by id) into the
  // session's recording buffer, which — unlike window.__tbTestSteps — survives
  // a full page navigation destroying the current JS context.
  private async harvestRecordingSteps(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      const steps = await s.view.webContents.executeJavaScript(`(window.__tbTestSteps||[]).map(function(x){return x;})`);
      if (!Array.isArray(steps)) return;
      let buf = this.recordingBuffers.get(id);
      if (!buf) { buf = new Map(); this.recordingBuffers.set(id, buf); }
      for (const step of steps as TestStep[]) buf.set(step.id, step);
      // silent: runs on every pollRecordingSteps() poll (~1s) and every nav while recording
    } catch {}
  }

  private getBufferedSteps(id: string): TestStep[] {
    const buf = this.recordingBuffers.get(id);
    if (!buf) return [];
    return Array.from(buf.values()).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  async startRecording(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.recordingBuffers.set(id, new Map());
    await s.view.webContents.executeJavaScript(RECORDING_SCRIPT).catch((e) => this.log.warn('recording', 'Failed to inject recording script', { sessionId: id, error: String(e) }));
    const navHandler = () => {
      s.view.webContents.executeJavaScript(RECORDING_SCRIPT)
        .catch((e) => this.log.warn('recording', 'Failed to re-inject recording script after navigation', { sessionId: id, error: String(e) }));
    };
    // A full navigation destroys the outgoing page's JS context (and
    // window.__tbTestSteps with it) before did-navigate fires, so harvest
    // whatever's recorded so far while that context is still alive.
    const preNavHandler = () => { this.harvestRecordingSteps(id); };
    s.view.webContents.on('will-navigate', preNavHandler);
    s.view.webContents.on('did-navigate', navHandler);
    s.view.webContents.on('did-navigate-in-page', navHandler);
    this.recordingHandlers.set(id, () => {
      s.view.webContents.off('will-navigate', preNavHandler);
      s.view.webContents.off('did-navigate', navHandler);
      s.view.webContents.off('did-navigate-in-page', navHandler);
    });
    this.log.info('recording', 'Recording started', { sessionId: id });
    return true;
  }

  async pollRecordingSteps(id: string): Promise<TestStep[]> {
    const s = this.sessions.get(id);
    if (!s) return [];
    await this.harvestRecordingSteps(id);
    return this.getBufferedSteps(id);
  }

  async stopRecording(id: string): Promise<TestStep[]> {
    const s = this.sessions.get(id);
    if (!s) return [];
    const dispose = this.recordingHandlers.get(id);
    if (dispose) { dispose(); this.recordingHandlers.delete(id); }
    try {
      const steps = await s.view.webContents.executeJavaScript(
        `(function(){var r=(window.__tbTestSteps||[]).slice();window.__tbTestSteps=[];window.__tbRecording=false;return r;})()`
      );
      if (Array.isArray(steps)) {
        let buf = this.recordingBuffers.get(id);
        if (!buf) { buf = new Map(); this.recordingBuffers.set(id, buf); }
        for (const step of steps as TestStep[]) buf.set(step.id, step);
      }
    } catch (e) {
      this.log.warn('recording', 'Failed to harvest final recording steps on stop', { sessionId: id, error: String(e) });
    }
    const result = this.getBufferedSteps(id);
    this.recordingBuffers.delete(id);
    this.log.info('recording', 'Recording stopped', { sessionId: id });
    return result;
  }

  async playbackStep(id: string, step: TestStep): Promise<{ success: boolean; error?: string }> {
    const s = this.sessions.get(id);
    if (!s) return { success: false, error: 'Session not found' };
    try {
      const result = await s.view.webContents.executeJavaScript(buildPlaybackScript(step));
      if (result && typeof result === 'object') return result as { success: boolean; error?: string };
      return { success: true };
    } catch (e) {
      // A thrown (rather than a returned {success:false,...}) error means the
      // injected script itself failed to run — that's a genuine functionality
      // bug (Tests playback or Follow Along mirroring), not an expected
      // assertion miss, so surface it in bug-report diagnostics too.
      this.log.error('sessions', `Playback '${step.type}'${step.selector ? ` (${step.selector})` : ''} failed: ${String(e)}`, { sessionId: id });
      return { success: false, error: String(e) };
    }
  }

  // Returns how many elements on the session's current page match `selector`,
  // or -1 if the selector itself is invalid — used to flag fragile recorded
  // selectors (0 matches = broken, >1 = ambiguous) before/while a test runs.
  async countSelectorMatches(id: string, selector: string): Promise<number> {
    const s = this.sessions.get(id);
    if (!s) return -1;
    try {
      const count = await s.view.webContents.executeJavaScript(
        `document.querySelectorAll(${JSON.stringify(selector)}).length`
      );
      return typeof count === 'number' ? count : -1;
    } catch {
      return -1;
    }
  }

  // ─── Follow Along ─────────────────────────────────────────────────────────
  // Links a "leader" session to a "follower" session: the leader keeps
  // recording clicks/fills via the same mechanism as Tests recording, but
  // instead of only buffering steps for later replay, each new step is
  // relayed to the follower and played back there in near real time via the
  // existing selector-based playbackStep(). Full-page navigation on the
  // leader (link clicks, redirecting submits, address-bar changes) is
  // mirrored separately at the WebContents level, gated by the pairing's own
  // mirrorNavigation toggle, since it isn't captured as a recorded step.

  private isSessionLinked(id: string): boolean {
    for (const p of this.followPairings.values()) {
      if (p.leaderId === id || p.followerId === id) return true;
    }
    return false;
  }

  async startFollowAlong(
    leaderId: string, followerId: string, mirrorNavigation: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    if (leaderId === followerId) return { ok: false, error: 'Pick two different sessions.' };
    const leader = this.sessions.get(leaderId);
    const follower = this.sessions.get(followerId);
    if (!leader || !follower) return { ok: false, error: 'Session not found.' };
    if (this.isSessionLinked(leaderId) || this.isSessionLinked(followerId)) {
      return { ok: false, error: 'One of these sessions is already part of a Follow Along link.' };
    }
    if (this.recordingHandlers.has(leaderId)) {
      return { ok: false, error: 'That session is already being recorded (Tests tab) — stop that first.' };
    }

    await this.startRecording(leaderId);

    // Full-page and in-page navigation both mirror through here — logged via
    // the same followAlong:stepResult event the click/fill relay path uses
    // (renderer/followalong.js already falls back to step.type for a kind it
    // doesn't special-case, but gives 'navigate'/'navigate-in-page' their own
    // description), so there's no silent-success gap for the tester to
    // second-guess. Gated on mirrorNavigation like the mirroring itself —
    // nothing is emitted, let alone logged, while it's off.
    const makeNavHandler = (kind: 'navigate' | 'navigate-in-page') => (_e: unknown, url: string) => {
      const pairing = this.followPairings.get(leaderId);
      if (!pairing?.mirrorNavigation) return;
      const followerSession = this.sessions.get(pairing.followerId);
      if (!followerSession) return;
      if (followerSession.view.webContents.getURL() === url) return;
      followerSession.view.webContents.loadURL(url)
        .then(() => {
          this.win.webContents.send('followAlong:stepResult', {
            leaderId, followerId: pairing.followerId, ...buildNavMirrorStepResult(kind, url),
          });
        })
        .catch((err: unknown) => {
          this.win.webContents.send('followAlong:stepResult', {
            leaderId, followerId: pairing.followerId,
            ...buildNavMirrorStepResult(kind, url, err instanceof Error ? err.message : String(err)),
          });
        });
    };
    const navHandler = makeNavHandler('navigate');
    const navInPageHandler = makeNavHandler('navigate-in-page');
    leader.view.webContents.on('did-navigate', navHandler);
    leader.view.webContents.on('did-navigate-in-page', navInPageHandler);

    // silent: polls every 300ms while Follow Along is active — too high-frequency to log
    const pollTimer = setInterval(() => { this.relayFollowSteps(leaderId).catch(() => {}); }, 300);

    this.followPairings.set(leaderId, {
      leaderId, followerId, mirrorNavigation, relayedSteps: new Map(), pollTimer, navHandler, navInPageHandler,
    });
    return { ok: true };
  }

  async stopFollowAlong(leaderId: string): Promise<boolean> {
    const pairing = this.followPairings.get(leaderId);
    if (!pairing) return false;
    clearInterval(pairing.pollTimer);
    const leader = this.sessions.get(leaderId);
    if (leader) {
      leader.view.webContents.off('did-navigate', pairing.navHandler);
      leader.view.webContents.off('did-navigate-in-page', pairing.navInPageHandler);
    }
    this.followPairings.delete(leaderId);
    if (this.recordingHandlers.has(leaderId)) await this.stopRecording(leaderId);
    return true;
  }

  setFollowMirrorNavigation(leaderId: string, mirrorNavigation: boolean): boolean {
    const pairing = this.followPairings.get(leaderId);
    if (!pairing) return false;
    pairing.mirrorNavigation = mirrorNavigation;
    return true;
  }

  listFollowPairings(): { leaderId: string; followerId: string; mirrorNavigation: boolean }[] {
    return Array.from(this.followPairings.values()).map((p) => ({
      leaderId: p.leaderId, followerId: p.followerId, mirrorNavigation: p.mirrorNavigation,
    }));
  }

  private async relayFollowSteps(leaderId: string): Promise<void> {
    const pairing = this.followPairings.get(leaderId);
    if (!pairing) return;
    await this.harvestRecordingSteps(leaderId);
    const steps = this.getBufferedSteps(leaderId);
    for (const step of steps) {
      // Full navigations are mirrored separately (see navHandler above) — the
      // recorded 'navigate' step type only covers in-page history API calls.
      if (step.type !== 'click' && step.type !== 'fill') continue;
      const lastRelayedValue = pairing.relayedSteps.get(step.id);
      if (step.type === 'click') {
        if (lastRelayedValue !== undefined) continue;
      } else if (lastRelayedValue === (step.value ?? '')) {
        continue;
      }
      pairing.relayedSteps.set(step.id, step.value ?? '');
      const result = await this.playbackStep(pairing.followerId, step);
      this.win.webContents.send('followAlong:stepResult', {
        leaderId, followerId: pairing.followerId, step, result,
      });
    }
  }
}
