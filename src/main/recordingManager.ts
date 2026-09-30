import type { AppLog } from './appLogger';

/**
 * Owns Record/Playback: the in-page recording script, per-frame step
 * harvesting/buffering, and step-by-step playback (#255, extracted from
 * sessionManager.ts once every Record/Playback bug-fix ticket in this
 * grooming batch — #242/#272/#273/#274 — had landed). FollowAlongManager
 * drives this class's startRecording/stopRecording/harvestRecordingSteps/
 * getBufferedSteps/playbackStep directly (see its own file) rather than
 * duplicating recording/playback mechanics, since Follow Along is "Tests
 * recording, relayed live to a second tab" under the hood.
 */

export interface TestStep {
  id: string;
  type: 'navigate' | 'click' | 'fill' | 'check' | 'assert-visible' | 'assert-not-visible' | 'assert-text' | 'assert-value' | 'assert-url' | 'assert-attr' | 'assert-enabled' | 'wait-visible' | 'wait-navigation';
  selector?: string;
  // string for every step except 'check', which records the resulting
  // el.checked state as a real boolean (#242) — not the checkbox/radio's
  // DOM `value` attribute (typically the meaningless string "on").
  value?: string | boolean;
  url?: string;
  attr?: string;
  timestamp?: number;
  description?: string;
  tagName?: string;
  // A password field's 'fill' step — its recorded/saved value is always the
  // literal placeholder '[hidden]', never the real keystrokes. Playback
  // never types that placeholder (#242); the renderer substitutes a real,
  // never-persisted value collected from the tester before calling
  // playbackStep for this step.
  sensitive?: boolean;
  // #273: set only when the step was recorded inside a non-top frame (an
  // iframe has its own `window`, so window.top !== window.self there) — the
  // frame's own location.href at record time. Absent for main-frame steps,
  // so existing saved tests (and their playback) are unaffected. playbackStep
  // uses this to find the matching live frame via framesInSubtree before
  // running buildPlaybackScript's generated JS in it, instead of always
  // running against the main frame.
  frameUrl?: string;
}

const KNOWN_STEP_TYPES = new Set<TestStep['type']>([
  'navigate', 'click', 'fill', 'check', 'assert-visible', 'assert-not-visible',
  'assert-text', 'assert-value', 'assert-url', 'assert-attr', 'assert-enabled',
  'wait-visible', 'wait-navigation',
]);

export type ImportableTest = { name: string; steps: TestStep[] };

// L6: a navigate step's URL is assigned to location.href in the tested page,
// so a javascript:/data:/file: URL would run or load attacker-chosen content
// in the tested session. Only http(s) is ever navigated to. An absent/empty
// URL is left alone (it has always meant a same-page reload).
export function isSafeNavigateUrl(url: unknown): boolean {
  if (url === undefined || url === '') return true;
  if (typeof url !== 'string') return false;
  try { const { protocol } = new URL(url); return protocol === 'http:' || protocol === 'https:'; } catch { return false; }
}

export interface ValidateImportedTestsResult {
  tests: ImportableTest[];
  skipped: { index: number; reason: string }[];
  // Set only when the whole file is rejected outright (not JSON at the
  // top level, or missing the testerBrowserTests marker) — tests/skipped
  // are both empty in that case.
  error?: string;
}

// #274: pure so every validation branch is unit-testable without the main
// process or dialogs around it, mirroring validateImportedMockRules (#264).
// `json` is whatever JSON.parse() produced — entirely untrusted. A test
// whose steps contain even one malformed or unrecognized-type step is
// skipped in its own entirety, not silently repaired by dropping just that
// step — a test's steps are an ordered sequence where a missing step could
// misalign selectors/assertions against the wrong state, unlike a Mock
// rule (#264) where each rule is independent and dropping one is safe. Step
// ids are regenerated fresh (not read from the file at all) so an import
// can never collide with an id already in use; the test's own top-level id
// is minted by the caller (importTests()) once a name collision is decided.
export function validateImportedTests(json: unknown): ValidateImportedTestsResult {
  if (!json || typeof json !== 'object' || Array.isArray(json) || (json as Record<string, unknown>).testerBrowserTests !== 1) {
    return { tests: [], skipped: [], error: 'Not a TesterBrowser Tests file' };
  }
  const rawTests = (json as Record<string, unknown>).tests;
  if (!Array.isArray(rawTests)) {
    return { tests: [], skipped: [], error: 'Not a TesterBrowser Tests file' };
  }

  const tests: ImportableTest[] = [];
  const skipped: { index: number; reason: string }[] = [];

  rawTests.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped.push({ index, reason: 'test is not an object' });
      return;
    }
    const t = raw as Record<string, unknown>;
    if (typeof t.name !== 'string' || t.name.length === 0) {
      skipped.push({ index, reason: 'name must be a non-empty string' });
      return;
    }
    if (!Array.isArray(t.steps)) {
      skipped.push({ index, reason: 'steps must be an array' });
      return;
    }

    const steps: TestStep[] = [];
    let badStepReason: string | null = null;
    for (const rawStep of t.steps) {
      if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
        badStepReason = 'a step is not an object';
        break;
      }
      const s = rawStep as Record<string, unknown>;
      if (typeof s.type !== 'string' || !KNOWN_STEP_TYPES.has(s.type as TestStep['type'])) {
        badStepReason = `unknown step type "${String(s.type)}"`;
        break;
      }
      if (s.type === 'navigate' && typeof s.url === 'string' && !isSafeNavigateUrl(s.url)) {
        badStepReason = 'navigate step URL must be http(s)';
        break;
      }
      steps.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: s.type as TestStep['type'],
        selector: typeof s.selector === 'string' ? s.selector : undefined,
        value: typeof s.value === 'string' || typeof s.value === 'boolean' ? s.value : undefined,
        url: typeof s.url === 'string' ? s.url : undefined,
        attr: typeof s.attr === 'string' ? s.attr : undefined,
        description: typeof s.description === 'string' ? s.description : undefined,
        tagName: typeof s.tagName === 'string' ? s.tagName : undefined,
        sensitive: typeof s.sensitive === 'boolean' ? s.sensitive : undefined,
        frameUrl: typeof s.frameUrl === 'string' ? s.frameUrl : undefined,
      });
    }
    if (badStepReason) {
      skipped.push({ index, reason: badStepReason });
      return;
    }

    tests.push({ name: t.name, steps });
  });

  return { tests, skipped };
}

// #242: pure mirror of RECORDING_SCRIPT's genSel() — specifically the
// data-*-attribute branch that shipped the bug this ticket fixes (it always
// named the selector "data-testid" regardless of which attribute actually
// matched). The in-page script can't import real code (it runs via
// executeJavaScript with no access to Node modules), so the two are
// hand-kept in sync rather than sharing code — this one exists purely so
// the priority-order/escaping logic has a unit-tested equivalent.
// `getAttr` mirrors `el.getAttribute`; returns null when none of the four
// attributes are present, same as genSel falling through to its next branch.
export function dataAttrSelector(getAttr: (name: string) => string | null): string | null {
  for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
    const value = getAttr(attr);
    if (value) return `[${attr}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  }
  return null;
}

const RECORDING_SCRIPT = `(function(){
  if(window.__tbRecording)return;
  window.__tbRecording=true;
  window.__tbTestSteps=window.__tbTestSteps||[];
  function esc(s){return(s||'').replace(/\\\\/g,'\\\\').replace(/"/g,'\\"');}
  function genSel(el){
    if(!el)return'';
    var dataAttrs=['data-testid','data-test','data-cy','data-qa'];
    for(var di=0;di<dataAttrs.length;di++){
      var dv=el.getAttribute(dataAttrs[di]);
      if(dv)return'['+dataAttrs[di]+'="'+esc(dv)+'"]';
    }
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
  function addStep(step){
    var extra={id:Date.now()+'_'+Math.random().toString(36).slice(2),timestamp:Date.now(),url:location.href};
    if(window.top!==window.self)extra.frameUrl=location.href;
    window.__tbTestSteps.push(Object.assign(extra,step));
  }
  document.addEventListener('click',function(e){
    var el=e.target;if(!el||el===document.documentElement||el===document.body)return;
    addStep({type:'click',selector:genSel(el),description:((el.textContent||el.value||el.getAttribute('aria-label')||'').trim()).slice(0,60),tagName:el.tagName.toLowerCase()});
  },true);
  function upsertCheck(el){
    var sel=genSel(el);
    var steps=window.__tbTestSteps;
    var last=steps.length?steps[steps.length-1]:null;
    if(last&&last.type==='check'&&last.selector===sel){
      last.value=el.checked;last.timestamp=Date.now();
    }else{
      addStep({type:'check',selector:sel,value:el.checked,tagName:el.tagName.toLowerCase()});
    }
  }
  function upsertFill(el){
    if(!el)return;
    if(el.type==='checkbox'||el.type==='radio'){upsertCheck(el);return;}
    if(!('value' in el))return;
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

// #273: each frame (main or iframe) has its own `window`, so RECORDING_SCRIPT's
// window.__tbTestSteps buffer lives separately per frame — these run per-frame
// via WebFrameMain.executeJavaScript, not once against the main webContents,
// so steps recorded inside a same-origin iframe are actually collected.
const HARVEST_STEPS_SCRIPT = `(function(){return (window.__tbTestSteps||[]).map(function(x){return x;});})()`;
const HARVEST_AND_CLEAR_STEPS_SCRIPT = `(function(){var r=(window.__tbTestSteps||[]).slice();window.__tbTestSteps=[];window.__tbRecording=false;return r;})()`;

// #272: sets a form element's value/checked state through the setter
// already on its *prototype* chain, not whatever's currently in effect on
// the element itself. React (and other controlled-component frameworks)
// installs its own setter directly on the element *instance* (an own
// property, shadowing — not replacing — the accessor already on its
// prototype) to track every value change; assigning el.value = x invokes
// that override, which updates its own tracker too, so the framework's own
// "did this really change" check (comparing its tracker's last-known value
// against the DOM's real one) finds no discrepancy and never fires
// onChange, even though el.value now shows the new text — React's very
// next render snaps the visible value back to its own (unchanged) state.
// Calling the *original* prototype setter directly bypasses that override
// entirely, leaving the tracker stale so the subsequent 'input'/'change'
// event reads as a genuine external change, the same way real typing does.
// Falls back to the plain native prototype (chosen from el.tagName, since
// this runs inside the page, not this process) if the element's own
// prototype somehow has no descriptor for the property at all. Exported (not
// just module-private) — sessionManager.ts's injectTestData() reuses this
// exact string to avoid duplicating the same logic for test-data insertion.
export const NATIVE_SET_VALUE_FN = `function __tbSetNativeValue(el,value){var np=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')||Object.getOwnPropertyDescriptor(np,'value');d.set.call(el,value);}`;
const NATIVE_SET_CHECKED_FN = `function __tbSetNativeChecked(el,value){var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'checked')||Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'checked');d.set.call(el,value);}`;

// Exported so #242's fixes (the sensitive-fill guard and the 'check' step
// type) have a unit-tested equivalent, since this function's actual work —
// picking the right generated-script branch per step — lives in real,
// directly importable TypeScript rather than trapped in an in-page template
// string the way RECORDING_SCRIPT's genSel() is (see dataAttrSelector above
// for that one).
export function buildPlaybackScript(step: TestStep): string {
  const sel = JSON.stringify(step.selector ?? '');
  const val = JSON.stringify(step.value ?? '');
  const helpers = `var __wait=function(fn,ms){return new Promise(function(res,rej){var s=Date.now();(function poll(){try{var r=fn();if(r!==null&&r!==false&&r!==undefined){res(r);return;}}catch(ex){}if(Date.now()-s>(ms||10000)){rej(new Error('Timeout'));return;}setTimeout(poll,120);})();});};var __find=function(sel){var el=document.querySelector(sel);if(!el)throw new Error('Element not found: '+sel);return el;};var __vis=function(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';};${NATIVE_SET_VALUE_FN}${NATIVE_SET_CHECKED_FN}`;
  switch (step.type) {
    case 'navigate':
      if (!isSafeNavigateUrl(step.url)) return `(function(){return {success:false,error:'Blocked navigate step: only http(s) URLs are allowed'};})()`;
      return `(function(){try{location.href=${JSON.stringify(step.url??'')};return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    case 'click': return `(async function(){${helpers}try{await __wait(function(){var el=document.querySelector(${sel});return el&&__vis(el)?el:null;});__find(${sel}).click();return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    case 'fill':
      // #242: the literal '[hidden]' placeholder must never be typed —
      // callers (executeTest's sensitive-value prompt in record-playback.js)
      // are responsible for substituting a real, never-persisted value onto
      // a *copy* of the step before calling playbackStep. If one somehow
      // reaches here un-substituted, fail loudly instead of typing the
      // placeholder text into the field.
      if (step.sensitive && (step.value === '[hidden]' || step.value === undefined)) {
        return `(function(){return {success:false,error:'Sensitive step has no real value to type — it should have been substituted before playback.'};})()`;
      }
      return `(async function(){${helpers}try{await __wait(function(){var el=document.querySelector(${sel});return el&&__vis(el)?el:null;});var el=__find(${sel});el.focus();__tbSetNativeValue(el,${val});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    case 'check': {
      const checked = step.value === true;
      return `(async function(){${helpers}try{await __wait(function(){var el=document.querySelector(${sel});return el&&__vis(el)?el:null;});var el=__find(${sel});__tbSetNativeChecked(el,${JSON.stringify(checked)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
    }
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

export interface RecordingSessionRef {
  webContents: Electron.WebContents;
}

export class RecordingManager {
  private log: AppLog;
  private getSession: (id: string) => RecordingSessionRef | undefined;
  private recordingHandlers = new Map<string, () => void>();
  // Accumulates recorded steps (keyed by step id) across a session's recording, so
  // steps survive a full page navigation destroying the page's own JS context.
  private recordingBuffers = new Map<string, Map<string, TestStep>>();
  // Cached by stopRecording() before it clears the live buffer — backs
  // getEvidenceSteps()'s "current or most recent recording" (#245).
  private lastRecordingSteps = new Map<string, TestStep[]>();
  // #273: CDP script identifier of RECORDING_SCRIPT, keyed by session id —
  // registered via Page.addScriptToEvaluateOnNewDocument so the recorder is
  // listening from a new document's very first script execution (no
  // reactive re-injection window after did-navigate where interactions go
  // unrecorded).
  private recordingScripts = new Map<string, string>();

  constructor(log: AppLog, getSession: (id: string) => RecordingSessionRef | undefined) {
    this.log = log;
    this.getSession = getSession;
  }

  private warnCdpFailure(sessionId: string, command: string, e: unknown) {
    this.log.warn('sessions', `CDP command '${command}' failed`, { sessionId, error: String(e) });
  }

  isRecording(id: string): boolean {
    return this.recordingHandlers.has(id);
  }

  hasAnyActiveRecording(): boolean {
    return this.recordingHandlers.size > 0;
  }

  cleanupSession(id: string): void {
    this.recordingHandlers.delete(id);
    this.recordingBuffers.delete(id);
    this.lastRecordingSteps.delete(id);
    this.recordingScripts.delete(id);
  }

  // Reads every frame's live in-progress steps and merges them (by id) into
  // the session's recording buffer, which — unlike window.__tbTestSteps —
  // survives a full page navigation destroying the current JS context. Each
  // frame (main or iframe) has its own `window`, so this walks the frame
  // tree rather than reading once off the main webContents (#273) — a step
  // recorded inside a same-origin iframe lives in that iframe's own
  // window.__tbTestSteps, invisible from the main frame's context. Public
  // (not just SessionManager-internal) — FollowAlongManager calls this
  // directly, same as it calls getBufferedSteps/playbackStep below.
  async harvestRecordingSteps(id: string): Promise<void> {
    const s = this.getSession(id);
    if (!s) return;
    let buf = this.recordingBuffers.get(id);
    if (!buf) { buf = new Map(); this.recordingBuffers.set(id, buf); }
    for (const frame of s.webContents.mainFrame.framesInSubtree) {
      try {
        const steps = await frame.executeJavaScript(HARVEST_STEPS_SCRIPT);
        if (!Array.isArray(steps)) continue;
        for (const step of steps as TestStep[]) buf.set(step.id, step);
        // silent: runs on every pollRecordingSteps() poll (~1s) and every nav while recording
      } catch {}
    }
  }

  getBufferedSteps(id: string): TestStep[] {
    const buf = this.recordingBuffers.get(id);
    if (!buf) return [];
    return Array.from(buf.values()).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  async startRecording(id: string): Promise<boolean> {
    const s = this.getSession(id);
    if (!s) return false;
    this.recordingBuffers.set(id, new Map());

    // #273: Page.addScriptToEvaluateOnNewDocument runs RECORDING_SCRIPT
    // before any of a new document's own scripts do, for every frame the
    // target creates (main frame and same-origin iframes alike) — unlike the
    // old approach of re-injecting via executeJavaScript() reactively from a
    // did-navigate handler, which only ran *after* the new page's own script
    // had already had a chance to run, silently dropping any interaction in
    // that window. Cross-origin iframes: Electron's webContents.debugger is
    // a single CDP session on the main frame's target: Chromium only
    // delivers Page.addScriptToEvaluateOnNewDocument to frames rendered in
    // that same renderer process, so a cross-origin (out-of-process) iframe
    // never receives it — confirmed locally (e2e/tests.spec.ts's iframe test
    // below only exercises the guaranteed-working same-origin case). This
    // matches the ticket's documented "cross-origin iframe recording" as an
    // accepted, unfixed limitation.
    const dbg = s.webContents.debugger;
    await dbg.sendCommand('Page.enable').catch((e) => this.warnCdpFailure(id, 'Page.enable', e));
    const existingScriptId = this.recordingScripts.get(id);
    if (existingScriptId) {
      await dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: existingScriptId })
        .catch((e) => this.warnCdpFailure(id, 'Page.removeScriptToEvaluateOnNewDocument', e));
      this.recordingScripts.delete(id);
    }
    const result = await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: RECORDING_SCRIPT })
      .catch((e) => { this.warnCdpFailure(id, 'Page.addScriptToEvaluateOnNewDocument', e); return null; }) as { identifier: string } | null;
    if (result?.identifier) this.recordingScripts.set(id, result.identifier);
    else this.log.error('recording', 'Failed to register recording script — new navigations may drop early interactions', { sessionId: id });

    // The CDP registration above only covers *future* document creations —
    // inject into whatever's already loaded (main frame and any existing
    // same-origin iframes) too, same as before.
    for (const frame of s.webContents.mainFrame.framesInSubtree) {
      await frame.executeJavaScript(RECORDING_SCRIPT)
        .catch((e) => this.log.warn('recording', 'Failed to inject recording script', { sessionId: id, error: String(e), frameUrl: frame.url }));
    }

    // A full navigation destroys the outgoing page's JS context (and
    // window.__tbTestSteps with it) before did-navigate fires, so harvest
    // whatever's recorded so far while that context is still alive. This is
    // the only nav-time handler needed now — re-injection is handled by the
    // CDP script registration above, not a did-navigate listener.
    const preNavHandler = () => { this.harvestRecordingSteps(id); };
    s.webContents.on('will-navigate', preNavHandler);
    this.recordingHandlers.set(id, () => {
      s.webContents.off('will-navigate', preNavHandler);
    });
    this.log.info('recording', 'Recording started', { sessionId: id });
    return true;
  }

  async pollRecordingSteps(id: string): Promise<TestStep[]> {
    const s = this.getSession(id);
    if (!s) return [];
    await this.harvestRecordingSteps(id);
    return this.getBufferedSteps(id);
  }

  async stopRecording(id: string): Promise<TestStep[]> {
    const s = this.getSession(id);
    if (!s) return [];
    const dispose = this.recordingHandlers.get(id);
    if (dispose) { dispose(); this.recordingHandlers.delete(id); }

    const scriptId = this.recordingScripts.get(id);
    if (scriptId) {
      await s.webContents.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId })
        .catch((e) => this.warnCdpFailure(id, 'Page.removeScriptToEvaluateOnNewDocument', e));
      this.recordingScripts.delete(id);
    }

    let buf = this.recordingBuffers.get(id);
    if (!buf) { buf = new Map(); this.recordingBuffers.set(id, buf); }
    for (const frame of s.webContents.mainFrame.framesInSubtree) {
      try {
        const steps = await frame.executeJavaScript(HARVEST_AND_CLEAR_STEPS_SCRIPT);
        if (Array.isArray(steps)) {
          for (const step of steps as TestStep[]) buf.set(step.id, step);
        }
      } catch (e) {
        this.log.warn('recording', 'Failed to harvest final recording steps on stop', { sessionId: id, error: String(e), frameUrl: frame.url });
      }
    }
    const result = this.getBufferedSteps(id);
    if (result.length) this.lastRecordingSteps.set(id, result);
    this.recordingBuffers.delete(id);
    this.log.info('recording', 'Recording stopped', { sessionId: id });
    return result;
  }

  async playbackStep(id: string, step: TestStep): Promise<{ success: boolean; error?: string }> {
    const s = this.getSession(id);
    if (!s) return { success: false, error: 'Session not found' };
    // #273: a step recorded inside an iframe carries the frame's own URL —
    // run the generated script against that live frame (matched by URL, the
    // same primitive SnapshotManager.restoreSnapshot()'s applyFrame uses for
    // #243) instead of the main frame. The ordinary (no frameUrl) case keeps
    // using webContents.executeJavaScript rather than a captured mainFrame
    // reference — a step immediately after one that itself navigates (e.g.
    // a click step whose handler changes location.href) needs the *current*
    // main frame at call time, not a WebFrameMain snapshot that may not
    // track across that navigation the same way.
    if (step.frameUrl) {
      const frame = s.webContents.mainFrame.framesInSubtree.find((f) => f.url === step.frameUrl);
      if (!frame) return { success: false, error: `Frame not found: ${step.frameUrl}` };
      try {
        const result = await frame.executeJavaScript(buildPlaybackScript(step));
        if (result && typeof result === 'object') return result as { success: boolean; error?: string };
        return { success: true };
      } catch (e) {
        this.log.error('sessions', `Playback '${step.type}'${step.selector ? ` (${step.selector})` : ''} failed: ${String(e)}`, { sessionId: id });
        return { success: false, error: String(e) };
      }
    }
    try {
      const result = await s.webContents.executeJavaScript(buildPlaybackScript(step));
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
    const s = this.getSession(id);
    if (!s) return -1;
    try {
      const count = await s.webContents.executeJavaScript(
        `document.querySelectorAll(${JSON.stringify(selector)}).length`
      );
      return typeof count === 'number' ? count : -1;
    } catch {
      return -1;
    }
  }

  // The active tab's *current* in-progress recording if one is running,
  // else its most recently *stopped* recording (stopRecording() above
  // caches the result here before clearing the live buffer) — "current or
  // most recent" per #245's acceptance criteria. Empty when neither exists.
  getEvidenceSteps(id: string): TestStep[] {
    const live = this.getBufferedSteps(id);
    if (live.length) return live;
    return this.lastRecordingSteps.get(id) ?? [];
  }
}
