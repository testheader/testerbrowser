import fs from 'fs';
import path from 'path';
import type { AppLog } from './appLogger';
import {
  RGB, WCAG_AA_NORMAL, WCAG_AA_LARGE, WCAG_AAA_NORMAL, WCAG_AAA_LARGE,
  contrastRatio, isLargeText, parseCssColor,
} from './a11yContrast';

/**
 * Owns the Accessibility tab's collector scripts and CDP orchestration
 * (#255, extracted from sessionManager.ts). Mostly stateless — nearly every
 * method is "run this script against this session's debugger/webContents
 * and return the result," so unlike Mock/Resilience's rule storage there's
 * no per-partition state to own; methods take the specific
 * `Electron.WebContents` they operate on directly rather than a `getSession`
 * lookup callback. The two exceptions: the vendored axe-core bundle is
 * cached once per app run (`axeSource`), and the focus-trap walk needs its
 * own logger for a failure buried inside a private helper rather than at
 * the top-level call site.
 *
 * `TestSession.a11yInspecting`/`a11yFocusOverlayOn` stay on TestSession
 * itself (SessionManager's own state) — SessionManager's thin wrappers set
 * those flags themselves before/after delegating the CDP work here, the
 * same division of labor as the a11yInspecting-gated Runtime.bindingCalled
 * branches in SessionManager's shared debugger message handler, which stay
 * there as shared CDP-dispatch infrastructure and only call into
 * `resolveNodeAtPoint` below for the actual DOM/AX lookup.
 */

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
// getLocalStorage) — walks the DOM to find visible leaf-text elements
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
  function parseRGBA(colorStr) {
    var m = colorStr && colorStr.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return { r: 255, g: 255, b: 255, a: 0 };
    var parts = m[1].split(',').map(function(s) { return parseFloat(s.trim()); });
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function isTransparent(colorStr) {
    return parseRGBA(colorStr).a === 0;
  }
  // Walks up from el, alpha-compositing every semi-transparent backgroundColor
  // with whatever's behind it (result = fg*alpha + bg*(1-alpha) per channel),
  // so e.g. rgba(0,0,0,0.5) over a white ancestor contrasts as mid-gray, not
  // as opaque black. Stops at the first fully opaque background or a
  // background-image (returned as-is — can't composite against an image), or
  // falls back to white once it runs off the top of the document.
  function effectiveBackground(el) {
    if (!el) return { color: 'rgb(255, 255, 255)' };
    var cs = getComputedStyle(el);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return { backgroundImage: true };
    var c = parseRGBA(cs.backgroundColor);
    if (c.a === 0) return effectiveBackground(el.parentElement);
    if (c.a >= 1) return { color: 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')' };
    var behind = effectiveBackground(el.parentElement);
    if (behind.backgroundImage) return { color: 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')' };
    var bg = parseRGBA(behind.color);
    var r = c.r * c.a + bg.r * (1 - c.a);
    var g = c.g * c.a + bg.g * (1 - c.a);
    var b = c.b * c.a + bg.b * (1 - c.a);
    return { color: 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')' };
  }
  // CSS.escape(el.id) so an id that's legal HTML but not a bare CSS
  // identifier (e.g. "a:b", "1st") still produces a selector that resolves.
  // With no id, walks up building an nth-of-type-qualified path — the same
  // pattern RECORDING_SCRIPT's genSel() already uses for its own non-id
  // fallback — so the result always resolves back to exactly this element,
  // not just the first tag+class match on the page.
  function selectorFor(el) {
    if (el.id) return el.tagName.toLowerCase() + '#' + CSS.escape(el.id);
    var parts = [], cur = el;
    while (cur && cur !== document.body && parts.length < 6) {
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      var s = cur.tagName.toLowerCase();
      var sibs = cur.parentElement ? [].slice.call(cur.parentElement.children).filter(function(x) { return x.tagName === cur.tagName; }) : [];
      if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      parts.unshift(s);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
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
// setInspectEnabled below. Computes tab order, draws a numbered badge per
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
// Shift+Tab presses, dispatched and read by detectFocusTrap below) — the
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

export class A11yService {
  private log: AppLog;
  // Lazily-read, cached contents of the vendored axe-core bundle — read once
  // per app run rather than on every violations scan. '' (not null) marks a
  // failed read so we don't retry the disk hit on every call.
  private axeSource: string | null = null;

  constructor(log: AppLog) {
    this.log = log;
  }

  async getA11yTree(webContents: Electron.WebContents): Promise<object[]> {
    const dbg = webContents.debugger;
    await dbg.sendCommand('Accessibility.enable');
    const result = await dbg.sendCommand('Accessibility.getFullAXTree') as { nodes?: object[] };
    return result.nodes ?? [];
  }

  async setInspectEnabled(webContents: Electron.WebContents): Promise<void> {
    const dbg = webContents.debugger;
    await dbg.sendCommand('Accessibility.enable');
    await dbg.sendCommand('Runtime.addBinding', { name: '__a11yHover' });
    await dbg.sendCommand('Runtime.addBinding', { name: '__a11yClick' });
    await dbg.sendCommand('Runtime.evaluate', {
      expression: `(function(){if(window.__a11yHoverSetup)return;window.__a11yHoverSetup=true;let t=0;document.addEventListener('mousemove',function(e){const n=Date.now();if(n-t<150)return;t=n;window.__a11yHover(JSON.stringify({x:Math.round(e.clientX),y:Math.round(e.clientY)}));},{passive:true});document.addEventListener('click',function(e){if(!window.__a11yHoverSetup)return;e.preventDefault();e.stopPropagation();window.__a11yClick(JSON.stringify({x:Math.round(e.clientX),y:Math.round(e.clientY)}));},{capture:true});})();`,
      includeCommandLineAPI: false,
    });
  }

  async setInspectDisabled(webContents: Electron.WebContents): Promise<void> {
    const dbg = webContents.debugger;
    await dbg.sendCommand('Runtime.evaluate', {
      expression: `window.__a11yHoverSetup=false;`,
      includeCommandLineAPI: false,
    });
    await dbg.sendCommand('Runtime.removeBinding', { name: '__a11yHover' });
    await dbg.sendCommand('Runtime.removeBinding', { name: '__a11yClick' });
  }

  // Resolves the AX node under a page-relative point — shared by the
  // Runtime.bindingCalled('__a11yHover'/'__a11yClick') branches in
  // SessionManager's debugger message handler, which stay there as shared
  // CDP-event-dispatch infrastructure and call into this for the actual
  // DOM/AX lookup.
  async resolveNodeAtPoint(dbg: Electron.Debugger, x: number, y: number): Promise<unknown | null> {
    const loc = await dbg.sendCommand('DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: false }) as { backendNodeId?: number };
    if (!loc.backendNodeId) return null;
    const ax = await dbg.sendCommand('Accessibility.queryAXTree', { backendNodeId: loc.backendNodeId }) as { nodes?: unknown[] };
    return ax.nodes?.[0] ?? null;
  }

  // Modeled on setInspectEnabled/Disabled above, but unlike Inspect
  // element's live hover/click bindings, this doesn't need a
  // Runtime.addBinding round trip: the whole scan (tab order + focus/style
  // diff) runs synchronously in one Runtime.evaluate and its result is the
  // list itself.
  async enableFocusOverlay(webContents: Electron.WebContents): Promise<FocusOrderItem[] | null> {
    const result = await webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: FOCUS_OVERLAY_ENABLE_SCRIPT,
      returnByValue: true,
    }) as { result?: { value?: string }; exceptionDetails?: unknown };
    if (result.exceptionDetails || typeof result.result?.value !== 'string') return null;
    return JSON.parse(result.result.value) as FocusOrderItem[];
  }

  async disableFocusOverlay(webContents: Electron.WebContents): Promise<void> {
    await webContents.debugger.sendCommand('Runtime.evaluate', { expression: FOCUS_OVERLAY_DISABLE_SCRIPT, includeCommandLineAPI: false });
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

  private async readActiveElement(webContents: Electron.WebContents): Promise<string> {
    try {
      return await webContents.executeJavaScript(READ_ACTIVE_ELEMENT_SCRIPT) as string;
    } catch {
      return '';
    }
  }

  private async focusElementBySelector(id: string, webContents: Electron.WebContents, selector: string): Promise<void> {
    try {
      await webContents.executeJavaScript(`
        (function(sel) {
          var el = document.querySelector(sel);
          if (el) el.focus({ preventScroll: true });
        })(${JSON.stringify(selector)})
      `);
    } catch (e) {
      this.log.warn('sessions', 'Failed to focus element by selector for focus-trap check', { sessionId: id, error: String(e) });
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
    webContents: Electron.WebContents, dbg: Electron.Debugger, n: number, reverse: boolean, expectedTerminal: string
  ): Promise<FocusTrapDirectionResult> {
    const maxSteps = 2 * n;
    const sequence: string[] = [];
    // The starting focus position (unfocused for a forward walk, the last
    // element for a reverse one) is set up by the caller before this runs.
    let prevDescriptor: string | null = null;
    for (let step = 0; step < maxSteps; step++) {
      await this.dispatchTabKey(dbg, reverse);
      const descriptor = await this.readActiveElement(webContents);
      sequence.push(descriptor);
      if (descriptor === prevDescriptor) break; // stopped changing — a dead end classify() will report
      prevDescriptor = descriptor;
    }
    return classifyFocusTrapSequence(sequence, expectedTerminal);
  }

  async detectFocusTrap(id: string, webContents: Electron.WebContents): Promise<FocusTrapResult | null> {
    const dbg = webContents.debugger;
    try {
      const raw = await webContents.executeJavaScript(FOCUS_CANDIDATES_LIST_SCRIPT) as string;
      const selectors = JSON.parse(raw) as string[];
      const n = selectors.length;
      const empty: FocusTrapDirectionResult = { passed: true, kind: 'pass', trappedElements: [], sequence: [] };
      if (n === 0) return { forward: empty, backward: empty };

      try { await webContents.executeJavaScript('document.activeElement && document.activeElement.blur();'); } catch {} // silent: best-effort blur reset — nothing focused is a normal, expected case
      // Walk with index-based terminals so classifyFocusTrapSequence compares
      // unique identifiers — READ_ACTIVE_ELEMENT_SCRIPT returns the element's
      // position index from window.__a11yTrapEls, not its CSS selector, so two
      // elements sharing the same tag/no-id string can't collide.
      const forward = await this.walkFocusTrap(webContents, dbg, n, false, String(n - 1));

      await this.focusElementBySelector(id, webContents, selectors[n - 1]);
      const backward = await this.walkFocusTrap(webContents, dbg, n, true, '0');

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

  // Logging on failure is the caller's job (SessionManager's own wrapper
  // logs based on the returned {ok:false, error} shape) — this method stays
  // logger-free like the rest of this class's methods, except the two
  // focus-trap helpers above which bury a failure inside a private helper.
  async getViolations(webContents: Electron.WebContents): Promise<A11yViolationsResult> {
    const axeSource = this.getAxeSource();
    if (!axeSource) {
      return { ok: false, error: 'axe-core bundle could not be loaded' };
    }
    const dbg = webContents.debugger;
    try {
      // Same isolated-world-free injection technique as setInspectEnabled's
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
        return { ok: false, error };
      }
      if (typeof result.result?.value !== 'string') {
        return { ok: false, error: 'axe-core returned no result' };
      }
      return { ok: true, violations: JSON.parse(result.result.value) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Scrolls to and briefly outlines the element a violation node points at.
  // Selector comes from axe's own `target` array — single-frame, single-
  // selector targets only (see renderer/a11y.js for the multi-frame/shadow-
  // DOM cases this deliberately doesn't handle).
  async highlightElement(webContents: Electron.WebContents, selector: string): Promise<boolean> {
    try {
      return await webContents.executeJavaScript(`
        (function(sel) {
          try {
            const el = document.querySelector(sel);
            if (!el) return false;
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            const prevOutline = el.style.outline;
            const prevOutlineOffset = el.style.outlineOffset;
            el.style.outline = '3px solid #ff5252';
            el.style.outlineOffset = '2px';
            setTimeout(() => { el.style.outline = prevOutline; el.style.outlineOffset = prevOutlineOffset; }, 2000);
            return true;
          } catch { return false; }
        })(${JSON.stringify(selector)})
      `);
    } catch {
      return false;
    }
  }

  async getContrastIssues(webContents: Electron.WebContents): Promise<ContrastIssue[] | null> {
    try {
      const raw = await webContents.executeJavaScript(CONTRAST_SCAN_SCRIPT) as string;
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
  async highlightNode(webContents: Electron.WebContents, backendDOMNodeId: number): Promise<boolean> {
    const dbg = webContents.debugger;
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

  async getAltLabelIssues(webContents: Electron.WebContents): Promise<AltLabelIssues | null> {
    try {
      const raw = await webContents.executeJavaScript(ALT_LABEL_SCAN_SCRIPT) as string;
      return JSON.parse(raw) as AltLabelIssues;
    } catch {
      return null;
    }
  }
}
