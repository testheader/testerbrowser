import { BrowserWindow, WebContentsView, session as electronSession, Menu, clipboard, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { SessionRecorder } from './recorder';
import { DownloadManager } from './downloadManager';
import { PermissionManager } from './permissionManager';

import { genFirstName, genLastName, genFullName, genEmail, genUUID, genDate, genPhone, genAddress, resolveTemplate } from './testdata';

// ─────────────────────────────────────────────────────────────────────────────

export interface MockRule {
  id: string;
  urlPattern: string;
  method: string;
  statusCode: number;
  body: string;
  enabled: boolean;
  hitCount: number;
  lastHitAt: number | null;
}

export type ResilienceType = 'error500' | 'timeout' | 'latency' | 'offline' | 'missing' | 'random500' | 'corrupt';

export interface ResilienceRule {
  id: string;
  type: ResilienceType;
  urlPattern: string;
  probability: number;
  latencyMs: number;
  enabled: boolean;
  hitCount: number;
  lastHitAt: number | null;
}

function matchesGlob(pattern: string, url: string): boolean {
  try {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(url);
  } catch { return false; }
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
  mockRules: MockRule[];
  resilienceRules: ResilienceRule[];
  a11yInspecting: boolean;
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
  attrValue?: string;
  timestamp?: number;
  description?: string;
  tagName?: string;
  sensitive?: boolean;
}

interface FollowPairing {
  leaderId: string;
  followerId: string;
  mirrorNavigation: boolean;
  relayedStepIds: Set<string>;
  pollTimer: ReturnType<typeof setInterval>;
  navHandler: (_e: unknown, url: string) => void;
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
    case 'assert-attr': return `(function(){try{var el=document.querySelector(${sel});if(!el)return {success:false,error:'Not found: '+${sel}};var v=el.getAttribute(${JSON.stringify(step.attr??'')});if(v!==${JSON.stringify(step.attrValue??'')})return {success:false,error:'Attr mismatch: "'+v+'"'};return {success:true};}catch(e){return {success:false,error:e.message};}})()`;
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
  private topBarHeight = 88;
  private rightPanelWidth = 0;
  private topInset = 0;
  private isViewVisible = true;
  private tabOrder: string[] = [];
  private sessionNotes = new Map<string, string>();
  private colorIndex = 0;
  private downloadManager: DownloadManager;
  private permissionManager: PermissionManager;
  private getRedactHeaders: () => boolean;
  private recordingHandlers = new Map<string, () => void>();
  // Accumulates recorded steps (keyed by step id) across a session's recording, so
  // steps survive a full page navigation destroying the page's own JS context.
  private recordingBuffers = new Map<string, Map<string, TestStep>>();
  // Live leader→follower links ("Follow Along"), keyed by leader session id.
  private followPairings = new Map<string, FollowPairing>();

  constructor(win: BrowserWindow, getRedactHeaders: () => boolean) {
    this.win = win;
    this.dbDir = path.join(app.getPath('userData'), 'recordings');
    this.getRedactHeaders = getRedactHeaders;
    this.downloadManager = new DownloadManager(win);
    this.permissionManager = new PermissionManager(win);
    this.win.on('resize', () => this.layoutActive());
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
      mockRules: [],
      resilienceRules: [],
      a11yInspecting: false,
    };

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
              if (node) view.webContents.send('a11y:nodeHovered', node);
            })().catch(() => {});
          }
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
              if (node) view.webContents.send('a11y:nodeClicked', node);
            })().catch(() => {});
          }
        } catch {}
        return;
      }
      if (method !== 'Fetch.requestPaused') return;
      const { requestId, request, networkId } = params as { requestId: string; request: { url: string; method: string }; networkId?: string };
      // Fetch.requestPaused's requestId is a Fetch-domain id, distinct from the
      // Network-domain requestId the recorder's Network.* events key off of —
      // tag the request under networkId (falling back to requestId when no
      // correlated network event exists) so the recorded response/failure
      // event actually carries the mock/resilience tag.
      const tagId = networkId || requestId;
      const dbg = view.webContents.debugger;
      const rule = testSession.mockRules.find(r =>
        r.enabled && (r.method === '*' || r.method === request.method) && matchesGlob(r.urlPattern, request.url)
      );
      if (rule) {
        rule.hitCount = (rule.hitCount || 0) + 1;
        rule.lastHitAt = Date.now();
        testSession.recorder.tagRequest(tagId, { mockRuleId: rule.id });
        dbg.sendCommand('Fetch.fulfillRequest', {
          requestId,
          responseCode: rule.statusCode,
          body: Buffer.from(rule.body).toString('base64'),
        }).catch(() => {});
        return;
      }
      const res = testSession.resilienceRules.find(r =>
        r.enabled && matchesGlob(r.urlPattern, request.url)
      );
      if (res && Math.random() < res.probability) {
        res.hitCount = (res.hitCount || 0) + 1;
        res.lastHitAt = Date.now();
        testSession.recorder.tagRequest(tagId, { resilienceRuleId: res.id, resilienceType: res.type });
        switch (res.type) {
          case 'error500':
          case 'random500':
            dbg.sendCommand('Fetch.fulfillRequest', { requestId, responseCode: 500, body: Buffer.from('Internal Server Error').toString('base64') }).catch(() => {});
            break;
          case 'timeout':
            dbg.sendCommand('Fetch.fulfillRequest', { requestId, responseCode: 504, body: Buffer.from('Gateway Timeout').toString('base64') }).catch(() => {});
            break;
          case 'offline':
            dbg.sendCommand('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }).catch(() => {});
            break;
          case 'missing':
            dbg.sendCommand('Fetch.fulfillRequest', { requestId, responseCode: 404, body: Buffer.from('Not Found').toString('base64') }).catch(() => {});
            break;
          case 'corrupt':
            dbg.sendCommand('Fetch.fulfillRequest', { requestId, responseCode: 200, body: Buffer.from('\x00\x01\x02\xff\xfe' + 'x'.repeat(20)).toString('base64') }).catch(() => {});
            break;
          case 'latency':
            setTimeout(() => {
              dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {});
            }, res.latencyMs || 2000);
            break;
          default:
            dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {});
        }
        return;
      }
      dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {});
    });
    this.sessions.set(id, testSession);

    ses.webRequest.onCompleted((details) => {
      try {
        const host = new URL(details.url).hostname;
        if (host) testSession.loadedDomains.add(host);
      } catch {}
    });

    if (opts.startUrl) {
      view.webContents.loadURL(opts.startUrl);
    } else {
      view.webContents.loadFile(NEWTAB_FILE);
    }

    view.webContents.on('did-navigate', (_e, url) => {
      const displayUrl = isNewtabUrl(url) ? '' : url;
      testSession.currentUrl = displayUrl;
      testSession.loadedDomains = new Set<string>();
      try { if (displayUrl) testSession.loadedDomains.add(new URL(displayUrl).hostname); } catch {}
      this.win.webContents.send('session:navigated', { id, url: displayUrl });
      this.sendNavState(id);
    });
    view.webContents.on('did-navigate-in-page', (_e, url) => {
      const displayUrl = isNewtabUrl(url) ? '' : url;
      testSession.currentUrl = displayUrl;
      this.win.webContents.send('session:navigated', { id, url: displayUrl });
      this.sendNavState(id);
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

    // Navigation failure
    view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // ignore subframe failures and user-aborted
      this.win.webContents.send('session:loadFailed', { id, errorCode, errorDescription, url: validatedURL });
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
    s.view.webContents.isDevToolsOpened() ? s.view.webContents.closeDevTools() : s.view.webContents.openDevTools();
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
      const sessions = Array.from(this.sessions.values())
        .filter(s => s.persistent)
        .sort((a, b) => (orderIndex.get(a.id) ?? Infinity) - (orderIndex.get(b.id) ?? Infinity))
        .map(s => ({ name: s.name, partition: s.partition, url: s.currentUrl, color: s.color }));
      const notes: Record<string, string> = {};
      for (const [id, note] of this.sessionNotes) {
        const s = this.sessions.get(id);
        if (s && note) notes[s.partition] = note;
      }
      fs.writeFileSync(this.sessionsFile, JSON.stringify({ sessions, notes }));
    } catch {}
  }

  loadAndRestoreSessions(): boolean {
    try {
      if (!fs.existsSync(this.sessionsFile)) return false;
      const { sessions, notes } = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf-8'));
      if (!sessions?.length) return false;
      for (const s of sessions) {
        const sess = this.createSession(s.name, { partition: s.partition, startUrl: s.url, color: s.color });
        if (notes?.[s.partition]) this.sessionNotes.set(sess.id, notes[s.partition]);
      }
      const first = this.sessions.values().next().value as TestSession | undefined;
      if (first) this.switchTo(first.id);
      this.cleanupOldRecordings().catch(() => {});
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
        } catch {}
      }
    } catch {}
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
    const bounds = this.win.getContentBounds();
    const top = this.topBarHeight + this.topInset;
    s.view.setBounds({
      x: 0,
      y: top,
      width: Math.max(0, bounds.width - this.rightPanelWidth),
      height: Math.max(0, bounds.height - top - this.consoleHeight),
    });
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
    this.topBarHeight = Math.max(88, height);
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

  // Same idea as setRightPanelWidth, but for HTML overlays that extend below
  // the topbar (e.g. the View/app-menu dropdowns) — push the view's top edge
  // down to clear the overlay instead of detaching the view entirely, so the
  // rest of the page keeps rendering underneath it.
  setTopInset(px: number) {
    this.topInset = Math.max(0, px);
    this.layoutActive();
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
    const cookies = await src.view.webContents.session.cookies.get({});
    for (const c of cookies) {
      const url = `${c.secure ? 'https' : 'http'}://${c.domain?.replace(/^\./, '')}${c.path}`;
      try {
        await dest.view.webContents.session.cookies.set({
          url, name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate,
        });
      } catch {}
    }
    return dest;
  }

  navigate(id: string, url: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.view.webContents.loadURL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  }

  getTimeline(id: string, opts?: { limit?: number; since?: number }) {
    return this.sessions.get(id)?.recorder.getTimeline(opts) ?? [];
  }

  getHAR(id: string): object | null {
    return this.sessions.get(id)?.recorder.exportHAR() ?? null;
  }

  getLoadedDomains(id: string): string[] {
    return Array.from(this.sessions.get(id)?.loadedDomains ?? []);
  }

  // ── Session snapshots ─────────────────────────────────────────────────────

  private async collectSnapshot(id: string): Promise<object | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    const cookies = await s.view.webContents.session.cookies.get({});
    let localStorageData: Record<string, string> = {};
    let sessionStorageData: Record<string, string> = {};
    try {
      const r = await s.view.webContents.executeJavaScript(
        'JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])))'
      );
      localStorageData = JSON.parse(r);
    } catch {}
    try {
      const r = await s.view.webContents.executeJavaScript(
        'JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map(k=>[k,sessionStorage.getItem(k)])))'
      );
      sessionStorageData = JSON.parse(r);
    } catch {}
    return { version: 1, ts: Date.now(), sessionName: s.name, url: s.currentUrl, cookies, localStorage: localStorageData, sessionStorage: sessionStorageData };
  }

  private async restoreSnapshot(id: string, snap: Record<string, unknown>): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    if (Array.isArray(snap.cookies)) {
      await s.view.webContents.session.clearStorageData({ storages: ['cookies'] });
      for (const c of snap.cookies as Electron.Cookie[]) {
        const url = `${c.secure ? 'https' : 'http'}://${(c.domain ?? '').replace(/^\./, '')}${c.path ?? '/'}`;
        try { await s.view.webContents.session.cookies.set({ url, name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate }); } catch {}
      }
    }
    if (snap.url && typeof snap.url === 'string') {
      await s.view.webContents.loadURL(snap.url);
      await new Promise<void>(r => setTimeout(r, 600));
    }
    const ls = snap.localStorage as Record<string, string> | undefined;
    if (ls && typeof ls === 'object') {
      const sets = Object.entries(ls).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)});`).join('');
      try { await s.view.webContents.executeJavaScript(`(function(){localStorage.clear();${sets}})();`); } catch {}
    }
    const ss = snap.sessionStorage as Record<string, string> | undefined;
    if (ss && typeof ss === 'object') {
      const sets = Object.entries(ss).map(([k, v]) => `sessionStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)});`).join('');
      try { await s.view.webContents.executeJavaScript(`(function(){sessionStorage.clear();${sets}})();`); } catch {}
    }
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
    }
  }

  async importSnapshotDialog(id: string): Promise<void> {
    const result = await dialog.showOpenDialog(this.win, {
      title: 'Import session snapshot',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (!result.canceled && result.filePaths[0]) {
      try {
        const snap = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8')) as Record<string, unknown>;
        await this.restoreSnapshot(id, snap);
        this.win.webContents.send('tab:action', { action: 'refresh' });
      } catch {}
    }
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
    `).catch(() => {});
  }

  applyTemplate(id: string, template: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.injectTestData(s.view, resolveTemplate(template));
  }

  async setEmulation(id: string, opts: { timezone?: string; locale?: string; latitude?: number; longitude?: number; accuracy?: number; clear?: boolean }): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    const dbg = s.view.webContents.debugger;
    if (opts.clear) {
      await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
      await dbg.sendCommand('Emulation.setLocaleOverride', { locale: '' }).catch(() => {});
      await dbg.sendCommand('Emulation.clearGeolocationOverride').catch(() => {});
      return;
    }
    if (opts.timezone !== undefined) await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: opts.timezone }).catch(() => {});
    if (opts.locale !== undefined)   await dbg.sendCommand('Emulation.setLocaleOverride', { locale: opts.locale }).catch(() => {});
    if (opts.latitude !== undefined && opts.longitude !== undefined) {
      await dbg.sendCommand('Emulation.setGeolocationOverride', { latitude: opts.latitude, longitude: opts.longitude, accuracy: opts.accuracy ?? 10 }).catch(() => {});
    }
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
    } catch { return null; }
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
      } catch {}
    } else {
      try {
        await dbg.sendCommand('Runtime.evaluate', {
          expression: `window.__a11yHoverSetup=false;`,
          includeCommandLineAPI: false,
        });
        await dbg.sendCommand('Runtime.removeBinding', { name: '__a11yHover' });
        await dbg.sendCommand('Runtime.removeBinding', { name: '__a11yClick' });
      } catch {}
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
    await s.view.webContents.session.cookies.remove(url, name).catch(() => {});
  }

  async clearCookies(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    const cookies = await s.view.webContents.session.cookies.get({});
    await Promise.all(cookies.map(c => {
      const host = (c.domain ?? '').replace(/^\./, '');
      const url = `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`;
      return s.view.webContents.session.cookies.remove(url, c.name).catch(() => {});
    }));
  }

  async deleteLocalStorageKey(id: string, key: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.view.webContents.executeJavaScript(
      `void localStorage.removeItem(${JSON.stringify(key)})`
    ).catch(() => {});
  }

  async setLocalStorageKey(id: string, key: string, value: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.view.webContents.executeJavaScript(
      `void localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`
    ).catch(() => {});
  }

  async clearLocalStorage(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.view.webContents.executeJavaScript('void localStorage.clear()').catch(() => {});
  }

  getMockRules(id: string): MockRule[] {
    return this.sessions.get(id)?.mockRules ?? [];
  }

  addMockRule(id: string, rule: MockRule): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.mockRules.push({ ...rule, hitCount: 0, lastHitAt: null });
    this._applyMocks(id);
  }

  removeMockRule(id: string, ruleId: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.mockRules = s.mockRules.filter(r => r.id !== ruleId);
    this._applyMocks(id);
  }

  toggleMockRule(id: string, ruleId: string, enabled: boolean): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const rule = s.mockRules.find(r => r.id === ruleId);
    if (rule) rule.enabled = enabled;
    this._applyMocks(id);
  }

  private _applyFetch(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const dbg = s.view.webContents.debugger;
    const activeMocks = s.mockRules.filter(r => r.enabled);
    const activeRes = s.resilienceRules.filter(r => r.enabled);
    if (activeMocks.length === 0 && activeRes.length === 0) {
      dbg.sendCommand('Fetch.disable').catch(() => {});
    } else if (activeRes.length > 0) {
      dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }).catch(() => {});
    } else {
      dbg.sendCommand('Fetch.enable', {
        patterns: activeMocks.map(r => ({ urlPattern: r.urlPattern, requestStage: 'Request' })),
      }).catch(() => {});
    }
  }

  /** @deprecated use _applyFetch */
  private _applyMocks(id: string): void { this._applyFetch(id); }

  getResilienceRules(id: string): ResilienceRule[] {
    return this.sessions.get(id)?.resilienceRules ?? [];
  }

  addResilienceRule(id: string, rule: ResilienceRule): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.resilienceRules.push({ ...rule, hitCount: 0, lastHitAt: null });
    this._applyFetch(id);
  }

  removeResilienceRule(id: string, ruleId: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.resilienceRules = s.resilienceRules.filter(r => r.id !== ruleId);
    this._applyFetch(id);
  }

  toggleResilienceRule(id: string, ruleId: string, enabled: boolean): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const rule = s.resilienceRules.find(r => r.id === ruleId);
    if (rule) { rule.enabled = enabled; this._applyFetch(id); }
  }

  updateResilienceRule(id: string, ruleId: string, patch: Partial<ResilienceRule>): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const rule = s.resilienceRules.find(r => r.id === ruleId);
    if (rule) { Object.assign(rule, patch); this._applyFetch(id); }
  }

  destroySession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const leaderId of Array.from(this.followPairings.keys())) {
      const p = this.followPairings.get(leaderId);
      if (p && (p.leaderId === id || p.followerId === id)) this.stopFollowAlong(leaderId).catch(() => {});
    }
    if (this.activeId === id) { this.win.contentView.removeChildView(s.view); this.activeId = null; }
    s.recorder.destroy();
    (s.view.webContents as any).destroy?.();
    this.sessions.delete(id);
    this.sessionNotes.delete(id);
    this.recordingHandlers.delete(id);
    this.recordingBuffers.delete(id);
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
    await s.view.webContents.executeJavaScript(RECORDING_SCRIPT).catch(() => {});
    const navHandler = () => { s.view.webContents.executeJavaScript(RECORDING_SCRIPT).catch(() => {}); };
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
    } catch {}
    const result = this.getBufferedSteps(id);
    this.recordingBuffers.delete(id);
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
      return { success: false, error: String(e) };
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

    const navHandler = (_e: unknown, url: string) => {
      const pairing = this.followPairings.get(leaderId);
      if (!pairing?.mirrorNavigation) return;
      const followerSession = this.sessions.get(pairing.followerId);
      if (!followerSession) return;
      if (followerSession.view.webContents.getURL() === url) return;
      followerSession.view.webContents.loadURL(url).catch(() => {});
    };
    leader.view.webContents.on('did-navigate', navHandler);
    leader.view.webContents.on('did-navigate-in-page', navHandler);

    const pollTimer = setInterval(() => { this.relayFollowSteps(leaderId).catch(() => {}); }, 300);

    this.followPairings.set(leaderId, {
      leaderId, followerId, mirrorNavigation, relayedStepIds: new Set(), pollTimer, navHandler,
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
      leader.view.webContents.off('did-navigate-in-page', pairing.navHandler);
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
      if (pairing.relayedStepIds.has(step.id)) continue;
      pairing.relayedStepIds.add(step.id);
      // Full navigations are mirrored separately (see navHandler above) — the
      // recorded 'navigate' step type only covers in-page history API calls.
      if (step.type !== 'click' && step.type !== 'fill') continue;
      const result = await this.playbackStep(pairing.followerId, step);
      this.win.webContents.send('followAlong:stepResult', {
        leaderId, followerId: pairing.followerId, step, result,
      });
    }
  }
}
