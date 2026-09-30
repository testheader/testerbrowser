import { BrowserWindow, WebContentsView, session as electronSession, Menu, clipboard, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { SessionRecorder } from './recorder';
import { buildHar } from './har';
import { DownloadManager } from './downloadManager';
import { PermissionManager, PermissionRecord } from './permissionManager';
import { AppLog } from './appLogger';
import {
  MockManager, MockRule, buildMockFulfillParams, buildMockPreflightParams,
} from './mockManager';
import { ResilienceManager, ResilienceRule } from './resilienceManager';
import { SnapshotManager, FrameSnapshot, waitForFrameLoad } from './snapshotManager';
import { EmulationManager, EmulationOverrides, EmulationPatch } from './emulationManager';
import { RecordingManager, TestStep, NATIVE_SET_VALUE_FN } from './recordingManager';
import { FollowAlongManager } from './followAlongManager';
import {
  A11yService, ContrastIssue, AltLabelIssues, FocusOrderItem, FocusTrapResult, A11yViolationsResult,
} from './a11yService';

import {
  genFirstName, genLastName, genFullName, genEmail, genUUID, genDate, genPhone, genAddress,
  genLongString, genUnicode, genRtl, genSqlInjection, genXss, genBoundaryNumber, genWhitespace, genTestCard,
  resolveTemplate,
} from './testdata';
import { COLLECT_FRAME_SCRIPT, COLLECT_INDEXEDDB_SCRIPT, buildRestoreFrameScript } from './snapshotScripts';
import { TabConditions, toCdpNetworkConditions, describeConditions } from './networkConditions';
import { filterRowsSince } from './jira';
import { writeJsonAtomic } from './jsonFile';
import { matchShortcut } from './shortcutTable';
import { NEWTAB_FILE, isNewtabFileUrl } from './newtabUrl';
import { isSafeId } from './pathSafety';

// ─────────────────────────────────────────────────────────────────────────────

// #227: SessionManager's default logger when none is injected (existing unit
// tests construct it directly without one).
const NOOP_LOG: AppLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

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
  // Real UA captured at session creation, before any override — the only
  // way to restore it once webContents.setUserAgent() has been called,
  // since Electron doesn't expose "reset to default" directly.
  defaultUserAgent: string;
  // #265: per-tab network/CPU throttling — undefined means never touched
  // (a fresh tab starts unthrottled, matching a real CDP session's default).
  conditions?: TabConditions;
  // #266: latest cert state for the current main-frame document (null for an
  // http: page, or before the first Security.visibleSecurityStateChanged
  // arrives), and the http: subresource URLs seen on it. Both reset on
  // did-navigate.
  securityState: CertificateSecurityState | null;
  mixedContentUrls: string[];
}

export interface HistoryEntry {
  url: string;
  ts: number;
  failed?: boolean;
}

// db name → { version, stores: { storeName → { keyPath, autoIncrement, records } } } —
// shared by session snapshots (FrameSnapshot.indexedDB) and the live Storage
// panel's IndexedDB view (SessionManager.getIndexedDB()).
export type IndexedDBSnapshot = Record<string, {
  version: number;
  stores: Record<string, { keyPath: string | string[] | null; autoIncrement: boolean; records: { key: unknown; value: unknown }[] }>;
}>;

// #266: a request counts as mixed content when CDP already classified it
// (`blockable`/`optionally-blockable`) or, when CDP gave no classification at
// all, when it's a plain-http request on an https page — the same fallback
// the ticket's own popover copy ("N insecure (http:) subresources") assumes.
// An explicit `mixedContentType: 'none'` from CDP is trusted as-is, never
// overridden by the URL-scheme fallback.
export function isMixedContent(pageUrl: string, reqUrl: string, mixedContentType?: string): boolean {
  if (mixedContentType === 'blockable' || mixedContentType === 'optionally-blockable') return true;
  if (mixedContentType !== undefined) return false;
  try {
    return new URL(pageUrl).protocol === 'https:' && new URL(reqUrl).protocol === 'http:';
  } catch {
    return false;
  }
}

// Cached from Security.visibleSecurityStateChanged's certificateSecurityState
// (epoch seconds for validFrom/validTo, matching CDP's own TimeSinceEpoch).
export interface CertificateSecurityState {
  protocol: string;
  keyExchange: string;
  cipher: string;
  subjectName: string;
  issuer: string;
  validFrom: number;
  validTo: number;
}

// The security:pageState IPC's return shape — cert fields are all-empty/zero
// for an http: page (no certificate), and the call returns null outright for
// a scheme the popover doesn't cover (file:, the new-tab page, etc).
export interface SecurityPageState extends CertificateSecurityState {
  mixedContentUrls: string[];
}

// Safety cap on how many mixed-content URLs one tab keeps in memory between
// navigations — a pathological page could otherwise grow this unboundedly.
// Well above the 10 the popover actually displays, so the count stays
// accurate for any page a tester would plausibly load.
const MAX_TRACKED_MIXED_CONTENT_URLS = 500;

const TAB_COLORS = [
  '#e06c75', '#61afef', '#98c379', '#c678dd',
  '#e5c07b', '#56b6c2', '#d19a66', '#be5046',
  '#2bbac5', '#d4896a',
];

export function getHostname(url: string): string {
  try { return new URL(url).hostname || 'New tab'; } catch { return 'New tab'; }
}

const MAX_CAPTURE_PX = 16384;
const NEWTAB_PRELOAD = path.join(__dirname, '..', 'preload', 'newtab.js');

function isNewtabUrl(url: string) {
  return isNewtabFileUrl(url);
}

function isSafeUrl(url: string): boolean {
  try { const { protocol } = new URL(url); return protocol === 'http:' || protocol === 'https:'; }
  catch { return false; }
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
  // Record/Playback (RECORDING_SCRIPT, step buffering, playback) lives in
  // RecordingManager, and Follow Along (leader→follower relay) in
  // FollowAlongManager, built on top of it (#255).
  private recordingManager: RecordingManager;
  private followAlongManager: FollowAlongManager;
  // #259: session ids with a Record/Playback run currently in progress —
  // toggled by the renderer's own run loop (runTest() in record-playback.js)
  // via session:setPlaybackActive, since a run is a sequence of individual
  // session:playbackStep IPC calls with no other main-process signal marking
  // its start/end. Backs isBusy() below, which the idle-auto-install check
  // (#259) uses to avoid installing mid-run.
  private playingIds = new Set<string>();
  // Per-session navigation history, newest entry last — cleared on destroy.
  private sessionHistory = new Map<string, HistoryEntry[]>();
  // #236: requests parked open by a `hang` Resilience rule — keyed by
  // session id (a live CDP requestId is only meaningful for the tab whose
  // debugger paused it), each entry its own optional release timer. Cleared
  // (timers included) in destroySession() since a hung request's tab going
  // away makes both the requestId and the point of releasing it moot.
  private hungRequests = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  // Mock/Resilience rules are a property of the session *partition* (cookies,
  // storage, cache — the thing "isolated sessions" actually means), not of
  // any one TestSession/tab object representing it — both managers key their
  // own storage by partition so rules survive that tab being destroyed and a
  // new one created for the same partition (reopen, "New tab in this
  // session"). Never cleared in destroySession(): another open tab, or a
  // future reopen, may still need the entry. Resilience rules aren't
  // persisted to disk (see #209's/#264's "Out of scope").
  private mockManager: MockManager;
  private resilienceManager = new ResilienceManager();
  // #241: emulation overrides live in EmulationManager (#255), scoped by
  // partition the same way — a partition with no entry there has never had
  // setEmulation() applied; a present (possibly empty) object records
  // whatever individual fields are actually in force. Only the bulk
  // `clear: true` path removes the entry entirely.
  private emulationManager: EmulationManager;
  private snapshotManager: SnapshotManager;
  // Accessibility tab collector scripts/CDP orchestration live in
  // A11yService (#255) — mostly stateless, so it's constructed with just a
  // logger, not a getSession callback; TestSession's own a11yInspecting/
  // a11yFocusOverlayOn flags stay here since they're SessionManager state.
  private a11yService: A11yService;
  // #227: replaces the old recordFeatureError(message) callback — every call
  // site now names its own source ('sessions' for nearly all of them) and
  // can attach a sessionId/ctx. Defaults to a no-op so existing unit tests
  // that construct SessionManager without a logger don't need updating.
  private log: AppLog;
  // Notifies the caller whenever a session is created/destroyed or navigates
  // — index.ts write-throughs the current URL list to disk on this so a hard
  // crash's next launch can recover what was open (see persistSessionUrls()).
  private onSessionsChanged: () => void;
  // #229: read fresh on every createSession() call (not cached at
  // construction) so a Settings change takes effect for the next tab opened,
  // without needing to reconstruct SessionManager itself.
  private getRecorderMaxEvents: () => number;
  // #270: read fresh on every popup, same reasoning as getRecorderMaxEvents
  // above — flipping the setting takes effect on the next window.open(),
  // no restart needed. Defaults closed so existing unit tests that construct
  // SessionManager directly keep today's deny-and-recreate behaviour.
  private getAllowRealPopups: () => boolean;

  constructor(
    win: BrowserWindow,
    getRedactHeaders: () => boolean,
    logger: AppLog = NOOP_LOG,
    onSessionsChanged: () => void = () => {},
    getRecorderMaxEvents: () => number = () => 20000,
    getAllowRealPopups: () => boolean = () => false
  ) {
    this.win = win;
    this.dbDir = path.join(app.getPath('userData'), 'recordings');
    this.getRedactHeaders = getRedactHeaders;
    this.log = logger;
    this.onSessionsChanged = onSessionsChanged;
    this.getRecorderMaxEvents = getRecorderMaxEvents;
    this.getAllowRealPopups = getAllowRealPopups;
    this.downloadManager = new DownloadManager(win);
    this.a11yService = new A11yService(this.log);
    this.mockManager = new MockManager(win);
    // #276: lets a permission prompt name the tab it belongs to — looked up
    // by the *requesting* webContents id (not the partition, unlike
    // DownloadManager's attribution), so it's correct even for two tabs
    // sharing a partition (e.g. a middle-clicked link).
    this.permissionManager = new PermissionManager(win, (webContentsId) =>
      Array.from(this.sessions.values()).find((s) => s.view.webContents.id === webContentsId)?.id ?? null
    );
    this.emulationManager = new EmulationManager(this.log, (id) => {
      const s = this.sessions.get(id);
      return s ? { partition: s.partition, webContents: s.view.webContents, defaultUserAgent: s.defaultUserAgent } : undefined;
    });
    this.snapshotManager = new SnapshotManager(
      win, this.log,
      (id) => {
        const s = this.sessions.get(id);
        return s ? { id: s.id, name: s.name, currentUrl: s.currentUrl, webContents: s.view.webContents } : undefined;
      },
      {
        createSession: (name) => this.createSession(name),
        switchTo: (id) => this.switchTo(id),
        destroySession: (id) => this.destroySession(id),
      }
    );
    const getRecordingSession = (id: string) => {
      const s = this.sessions.get(id);
      return s ? { webContents: s.view.webContents } : undefined;
    };
    this.recordingManager = new RecordingManager(this.log, getRecordingSession);
    this.followAlongManager = new FollowAlongManager(win, this.log, getRecordingSession, {
      isRecording: (id) => this.recordingManager.isRecording(id),
      startRecording: (id) => this.recordingManager.startRecording(id),
      stopRecording: (id) => this.recordingManager.stopRecording(id),
      harvestRecordingSteps: (id) => this.recordingManager.harvestRecordingSteps(id),
      getBufferedSteps: (id) => this.recordingManager.getBufferedSteps(id),
      playbackStep: (id, step) => this.recordingManager.playbackStep(id, step),
    });
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
      throttleLabel: describeConditions(s.conditions),
    }));
  }

  createSession(
    name: string,
    opts: { persistent?: boolean; startUrl?: string; partition?: string; color?: string; pinned?: boolean; id?: string } = {}
  ): TestSession {
    // #268: loadAndRestoreSessions() passes the id a persistent session was
    // last saved with, so its id — and therefore its notes, keyed by id —
    // survive a restart instead of churning on every launch. Any other
    // caller (new tab, clone, reopen, popup) leaves this unset and gets a
    // fresh one as before.
    // L5: opts arrives straight from the renderer on sessions:create, and the
    // id names the recorder's SQLite file — an unsafe one is replaced, not used.
    const id = isSafeId(opts.id) ? opts.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partition = opts.partition ?? (opts.persistent ? `persist:${id}` : id);
    const persistent = !!opts.persistent || partition.startsWith('persist:');
    // Seed the rule buckets for this partition if this is the first tab ever
    // to represent it — a partition passed in explicitly (reopen, "New tab
    // in this session") may already have an entry, which must be left alone.
    this.mockManager.ensurePartition(partition);
    this.resilienceManager.ensurePartition(partition);
    const ses = electronSession.fromPartition(partition);

    this.downloadManager.attach(ses, id);
    this.permissionManager.attach(ses, partition);

    const view = new WebContentsView({
      webPreferences: { session: ses, contextIsolation: true, sandbox: true, preload: NEWTAB_PRELOAD },
    });

    const recorder = new SessionRecorder(view.webContents, {
      sessionId: id,
      dbDir: this.dbDir,
      getRedact: this.getRedactHeaders,
      maxEventsPerSession: this.getRecorderMaxEvents(),
      // #229: a temp tab's traffic (including bodies) never touches disk —
      // only its session partition is in-memory before this, not its
      // recording.
      inMemory: !persistent,
    });
    // #266: the recorder's constructor already attached the debugger and
    // enabled Network/Log/Runtime — Security is a separate one-off enable so
    // the lock-icon popover gets certificate + mixed-content data.
    view.webContents.debugger.sendCommand('Security.enable').catch(() => {}); // silent: best-effort, popover just shows no data if this fails

    const color = opts.color ?? TAB_COLORS[this.colorIndex++ % TAB_COLORS.length];
    const testSession: TestSession = {
      id, name,
      persistent,
      partition,
      currentUrl: opts.startUrl || '',
      pinned: opts.pinned ?? false,
      color,
      view, recorder,
      createdAt: Date.now(),
      loadedDomains: new Set<string>(),
      a11yInspecting: false,
      a11yFocusOverlayOn: false,
      defaultUserAgent: view.webContents.getUserAgent(),
      devToolsOpen: false,
      securityState: null,
      mixedContentUrls: [],
    };
    const fetchPauseRateState: FetchPauseRateState = { windowStart: 0, count: 0 };

    // Handle CDP events: Fetch.requestPaused for mock/resilience rules, Runtime.bindingCalled for a11y hover
    view.webContents.debugger.on('message', (_e: unknown, method: string, params: Record<string, unknown>) => {
      if (method === 'Runtime.bindingCalled' && (params as { name?: string }).name === '__a11yHover' && testSession.a11yInspecting) {
        try {
          const { x, y } = JSON.parse((params as { payload?: string }).payload ?? '{}') as { x?: number; y?: number };
          if (typeof x === 'number' && typeof y === 'number') {
            this.a11yService.resolveNodeAtPoint(view.webContents.debugger, x, y)
              .then((node) => { if (node) this.win.webContents.send('a11y:nodeHovered', node); })
              .catch(() => {}); // silent: fires per mousemove while a11y inspect is on — too high-frequency to log
          }
        // silent: fires per mousemove while a11y inspect is on — too high-frequency to log
        } catch {}
        return;
      }
      if (method === 'Runtime.bindingCalled' && (params as { name?: string }).name === '__a11yClick' && testSession.a11yInspecting) {
        try {
          const { x, y } = JSON.parse((params as { payload?: string }).payload ?? '{}') as { x?: number; y?: number };
          if (typeof x === 'number' && typeof y === 'number') {
            this.a11yService.resolveNodeAtPoint(view.webContents.debugger, x, y)
              .then((node) => { if (node) this.win.webContents.send('a11y:nodeClicked', node); })
              .catch(() => {}); // silent: CDP event handler (a11y click binding) — too high-frequency to log
          }
        // silent: CDP event handler (a11y click binding) — too high-frequency to log
        } catch {}
        return;
      }
      if (method === 'Security.visibleSecurityStateChanged') {
        const cert = (params as {
          visibleSecurityState?: { certificateSecurityState?: CertificateSecurityState };
        }).visibleSecurityState?.certificateSecurityState;
        testSession.securityState = cert
          ? {
              protocol: cert.protocol,
              keyExchange: cert.keyExchange,
              cipher: cert.cipher,
              subjectName: cert.subjectName,
              issuer: cert.issuer,
              validFrom: cert.validFrom,
              validTo: cert.validTo,
            }
          : null;
        return;
      }
      if (method === 'Network.requestWillBeSent') {
        const { request } = params as { request?: { url: string; mixedContentType?: string } };
        if (
          request
          && testSession.mixedContentUrls.length < MAX_TRACKED_MIXED_CONTENT_URLS
          && isMixedContent(testSession.currentUrl, request.url, request.mixedContentType)
        ) {
          testSession.mixedContentUrls.push(request.url);
        }
        return;
      }
      if (method !== 'Fetch.requestPaused') return;
      const { requestId, request, networkId } = params as {
        requestId: string;
        request: { url: string; method: string; headers?: Record<string, string> };
        networkId?: string;
      };
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
      // A CORS preflight never carries the rule's own method (it's always
      // OPTIONS), so it can't be found by findMatchingMockRule's method
      // match — it's answered directly from any enabled cors:true rule
      // whose URL pattern matches, regardless of that rule's configured
      // method.
      if (request.method === 'OPTIONS') {
        const preflightRule = this.mockManager.findCorsPreflightMatch(testSession.partition, request.url);
        if (preflightRule) {
          dbg.sendCommand('Fetch.fulfillRequest', { requestId, ...buildMockPreflightParams({ headers: request.headers }) }).catch(() => {}); // silent: Fetch.requestPaused fires per request — too high-frequency to log
          return;
        }
      }
      const rule = this.mockManager.findMatch(testSession.partition, request.method, request.url);
      if (rule) {
        // #263: counted at match time, not at fulfilment — a delayed rule's
        // hit count/last-hit-at reflect when the request was actually
        // intercepted, not when the (possibly much later) response goes out.
        this.mockManager.recordHit(rule);
        testSession.recorder.tagRequest(tagId, { mockRuleId: rule.id });
        const fulfill = () =>
          dbg.sendCommand('Fetch.fulfillRequest', { requestId, ...buildMockFulfillParams(rule, { headers: request.headers }) })
            .catch(() => {}); // silent: the tab may have navigated/closed by the time a delayed fulfillment fires — the request is simply gone
        if (rule.delayMs && rule.delayMs > 0) {
          setTimeout(fulfill, rule.delayMs);
        } else {
          fulfill();
        }
        return;
      }
      const res = this.resilienceManager.pickMatch(testSession.partition, request);
      if (res) {
        this.resilienceManager.recordHit(res);
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
          case 'stall504':
            setTimeout(() => {
              dbg.sendCommand('Fetch.fulfillRequest', { requestId, responseCode: 504, body: Buffer.from('Gateway Timeout').toString('base64') }).catch(() => {}); // silent: see comment above switch
            }, res.latencyMs || 30_000);
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
          case 'hang': {
            // Deliberately no Fetch response at all — the paused request
            // stays paused, so the page sees it as pending until the tester
            // aborts client-side or navigates away. Tracked per session so
            // destroySession() can clear the release timer (if any) rather
            // than firing it against a tab that no longer exists.
            const hungForSession = this.hungRequestsForSession(testSession.id);
            const releaseTimer = res.releaseAfterMs
              ? setTimeout(() => {
                  hungForSession.delete(requestId);
                  dbg.sendCommand('Fetch.failRequest', { requestId, errorReason: 'TimedOut' }).catch(() => {}); // silent: see comment above switch
                }, res.releaseAfterMs)
              : null;
            hungForSession.set(requestId, releaseTimer);
            break;
          }
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
      // either) — except the 'hang' case just above, whose entire point
      // (#236) is to leave the request genuinely unanswered on purpose.
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
    // #241: same idea as _applyFetch() just above, for emulation — this
    // tab's own CDP debugger has never had any Emulation.* override pushed
    // to it, so a partition with existing overrides (popup, "new tab in
    // this session," reopen) needs them re-applied to actually take effect
    // on this specific tab's page, not just be remembered in the map.
    const existingEmulation = this.emulationManager.getByPartition(partition);
    if (existingEmulation && Object.keys(existingEmulation).length > 0) {
      this.setEmulation(id, { ...existingEmulation })
        .catch((e) => this.log.warn('sessions', 'Failed to re-apply emulation overrides to a new same-partition tab', { sessionId: id, error: String(e) }));
    }

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
      // #266: mixed-content list and cached cert state are scoped to one
      // main-frame document — a fresh navigation starts them over (the next
      // Security.visibleSecurityStateChanged repopulates securityState).
      testSession.mixedContentUrls = [];
      testSession.securityState = null;
      try { if (displayUrl) testSession.loadedDomains.add(new URL(displayUrl).hostname); } catch {} // silent: displayUrl is Electron's own just-navigated-to URL
      if (displayUrl) this.addHistoryEntry(id, displayUrl);
      this.win.webContents.send('session:navigated', { id, url: displayUrl });
      this.sendNavState(id);
      // #265: a cross-process navigation can swap the renderer CDP is
      // actually talking to, which would silently drop any active
      // network/CPU throttling — cheap and idempotent to just always
      // re-issue it here rather than try to detect a process swap.
      if (testSession.conditions) void this.applyConditions(id, testSession.conditions);
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
            {
              label: 'Edge cases',
              submenu: [
                { label: 'Long string',      click: () => inject(genLongString()) },
                { label: 'Unicode/emoji',    click: () => inject(genUnicode()) },
                { label: 'RTL text',         click: () => inject(genRtl()) },
                { label: 'SQL injection',    click: () => inject(genSqlInjection()) },
                { label: 'XSS',              click: () => inject(genXss()) },
                { label: 'Boundary number',  click: () => inject(genBoundaryNumber()) },
                { label: 'Whitespace only',  click: () => inject(genWhitespace()) },
                { label: 'Test card number', click: () => inject(genTestCard()) },
              ],
            },
            { type: 'separator' },
            { label: 'Custom template…', click: () => this.win.webContents.send('testdata:promptTemplate', { sessionId: id }) },
          ],
        });
        items.push({ type: 'separator' });
      } else {
        if (params.selectionText) {
          items.push({ label: 'Copy', click: () => view.webContents.copy() });
        }
        // #244: with no input focused there's no specific field to target
        // with the quick-generator submenu above, so this opens the custom-
        // template modal directly — the same testdata:promptTemplate event
        // the focused-input submenu's "Custom template…" item sends.
        items.push({ label: 'Fill with test data…', click: () => this.win.webContents.send('testdata:promptTemplate', { sessionId: id }) });
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

      // Ctrl+Tab (needs the reverse-direction flag) and Ctrl+1–9 (needs the
      // digit) carry extra data a flat key match can't express — see
      // shortcutTable.ts for why these two stay their own branches ahead of
      // the shared table instead of being entries in it.
      if (ctrl && key === 'Tab')            { event.preventDefault(); this.win.webContents.send('tabs:cycle', { reverse: shift }); return; }
      if (ctrl && key >= '1' && key <= '9') { event.preventDefault(); this.win.webContents.send('app:shortcut', `switchTab:${key}`); return; }

      const match = matchShortcut({ ctrl, shift, alt, key });
      if (!match) return;
      event.preventDefault();
      if (!match.direct) { this.win.webContents.send('app:shortcut', match.action); return; }
      switch (match.action) {
        case 'devtools':  this.toggleDevTools(this.activeId ?? ''); break;
        case 'zoomIn':    this.setZoom(this.activeId ?? '', 0.1); break;
        case 'zoomOut':   this.setZoom(this.activeId ?? '', -0.1); break;
        case 'zoomReset': this.resetZoom(this.activeId ?? ''); break;
        case 'back':      this.back(this.activeId ?? ''); break;
        case 'forward':   this.forward(this.activeId ?? ''); break;
      }
    });

    view.webContents.on('zoom-changed', (_event, zoomDirection) => {
      this.setZoom(id, zoomDirection === 'in' ? 0.1 : -0.1);
    });

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (!isSafeUrl(url)) return { action: 'deny' };
      // #270: opt-in "real popup" path for flows that depend on
      // window.opener/postMessage back to the opener (OAuth consent,
      // payment-provider popups) — the deny-and-recreate path below always
      // breaks that, since it loads the URL into a brand-new, disconnected
      // WebContentsView rather than letting Chromium open a linked window.
      // Returning action:'allow' lets Chromium keep the opener linkage
      // automatically (it already withholds it on its own for a page that
      // requested noopener, regardless of what we return here — nothing
      // extra needed for that case). overrideBrowserWindowOptions shares the
      // opener's own session/partition so the popup sees the same
      // cookies/login state.
      //
      // This intentionally does NOT attempt to make the popup a tracked tab
      // (sessions:list()/the tab strip) or attach a SessionRecorder to it.
      // Electron's action:'allow' path (with no `createWindow` override)
      // always builds a genuine separate native BrowserWindow — fundamentally
      // a different construct from this app's WebContentsView-embedded,
      // single-window tab model, which TestSession/switchTo/the layout
      // system are all built around. The only way to make the popup a real
      // tab is `createWindow` returning our own WebContentsView's
      // webContents instead of letting Electron build a BrowserWindow — that
      // path is real (Electron's own docs mention it for exactly this use
      // case), but requires extracting/duplicating createSession()'s ~470
      // lines of per-tab wiring (CDP message handling, navigation/title/
      // favicon forwarding), which isn't something this change can safely
      // verify without a real Electron display to run it against. Recording
      // that's attached but has no UI to view it wouldn't give testers real
      // visibility either. Settling for "shows as an unmanaged native
      // window, closable normally" per this ticket's own fallback.
      if (this.getAllowRealPopups()) {
        return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session: ses } } };
      }
      setImmediate(() => {
        const newSession = this.createSession(getHostname(url), { partition, startUrl: url, color });
        this.switchTo(newSession.id);
        this.win.webContents.send('session:newTab', { id: newSession.id });
      });
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

  // #259: set by the renderer around its own playback run loop (a run is a
  // sequence of individual session:playbackStep calls, so it — not this
  // class — is the only thing that knows when a run starts/ends). `id` is
  // accepted for a future per-session breakdown but isBusy() below only
  // needs "is anything playing at all" today.
  setPlaybackActive(id: string, active: boolean) {
    if (active) this.playingIds.add(id); else this.playingIds.delete(id);
  }

  // #259: backs the idle-auto-install check — installing mid-recording, mid-
  // Follow-Along or mid-playback-run would pull the rug out from under
  // whatever the tester (or a running test) is doing.
  isBusy(): { recording: boolean; following: boolean; playing: boolean } {
    return {
      recording: this.recordingManager.hasAnyActiveRecording(),
      following: this.followAlongManager.hasAnyActivePairing(),
      playing: this.playingIds.size > 0,
    };
  }

  // --- Download actions (delegated) ---

  listDownloads()       { return this.downloadManager.list(); }
  openDownload(id: string)   { this.downloadManager.open(id); }
  revealDownload(id: string) { this.downloadManager.reveal(id); }
  cancelDownload(id: string) { this.downloadManager.cancel(id); }
  clearDownloads()      { this.downloadManager.clear(); }

  // --- Permission (delegated) ---

  respondPermission(reqId: string, granted: boolean) { this.permissionManager.respond(reqId, granted); }

  // #276: revocation UI — both scoped by the active tab's own partition
  // (PermissionManager only knows partitions, not session ids), so a shared-
  // partition tab's grants show correctly on any of its sibling tabs too.
  listPermissions(id: string): PermissionRecord[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    return this.permissionManager.list(s.partition);
  }

  revokePermission(id: string, origin: string, permission: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    return this.permissionManager.revoke(s.partition, origin, permission);
  }

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
        if (!c) return;
        this.win.webContents.send('session:newTab', { id: c.session.id });
        if (c.warnings.length) this.showSnapshotWarnings('Clone session', c.warnings);
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
        // #268: `id` is new — saved (and, on the next load, passed back into
        // createSession) so a persistent session's id, and anything keyed by
        // it (notes, its recording file), survives a restart instead of
        // getting a fresh random id every launch. A file from before this
        // field existed just has restored sessions get fresh ids again, same
        // as always — see the notes-migration comment below.
        .map(s => ({ id: s.id, name: s.name, partition: s.partition, url: s.currentUrl, color: s.color, pinned: s.pinned }));
      // #268: keyed by session id, not partition — two persistent tabs
      // sharing a partition ("New tab in this session") used to collide on
      // a single partition-keyed slot here, silently losing whichever one
      // didn't iterate last. Only persistent sessions are kept: a temporary
      // session's notes have no corresponding entry in `sessions` above to
      // ever be reattached to, so keeping them would just grow the file
      // forever.
      const notes: Record<string, string> = {};
      for (const [id, note] of this.sessionNotes) {
        const s = this.sessions.get(id);
        if (s && s.persistent && note) notes[id] = note;
      }
      const emulation: Record<string, EmulationOverrides> = {};
      for (const s of persistentSessions) {
        const applied = this.emulationManager.getByPartition(s.partition);
        if (applied && Object.keys(applied).length > 0) emulation[s.partition] = applied;
      }
      // #264: keyed by partition, like emulation above — mockRulesByPartition
      // already is. hitCount/lastHitAt are reset in the saved copy: a hit
      // count is this run's traffic, not something worth restoring stale
      // across a restart. Temp sessions never contribute here since they're
      // filtered out of persistentSessions above.
      const mocks: Record<string, MockRule[]> = {};
      for (const s of persistentSessions) {
        const rules = this.mockManager.peek(s.partition);
        if (rules && rules.length > 0) {
          mocks[s.partition] = rules.map(r => ({ ...r, hitCount: 0, lastHitAt: null }));
        }
      }
      writeJsonAtomic(this.sessionsFile, { sessions, notes, emulation, mocks });
    } catch (e) {
      this.log.warn('sessions', 'Failed to save sessions to disk', { error: String(e) });
    }
  }

  loadAndRestoreSessions(): boolean {
    try {
      if (!fs.existsSync(this.sessionsFile)) return false;
      const { sessions, notes, emulation, mocks } = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf-8'));
      if (!sessions?.length) return false;
      const restored: { partition: string; sess: TestSession }[] = [];
      for (const s of sessions) {
        const sess = this.createSession(s.name, { id: s.id, partition: s.partition, startUrl: s.url, color: s.color, pinned: s.pinned });
        restored.push({ partition: s.partition, sess });
        // Re-apply persisted overrides through setEmulation (not just record
        // them on s.emulation) so the CDP commands / date-offset script are
        // genuinely in force on the newly-created target, not merely
        // remembered by the panel.
        if (emulation?.[s.partition]) {
          this.setEmulation(sess.id, emulation[s.partition])
            .catch((e) => this.log.warn('sessions', 'Failed to restore emulation override on load', { sessionId: sess.id, error: String(e) }));
        }
        // #264: restored into the MockManager's own partition storage
        // (shared by every tab on this partition, same as live rules are)
        // and _applyFetch is called for *this* session specifically — each
        // tab has its own CDP debugger/Fetch.enable registration, so a
        // partition with several restored tabs needs this per tab, not just
        // once per partition.
        const partitionMocks = mocks?.[s.partition];
        if (Array.isArray(partitionMocks) && partitionMocks.length > 0) {
          this.mockManager.restorePartition(s.partition, partitionMocks);
          this._applyFetch(sess.id);
        }
      }
      // #268: a file saved before notes were id-keyed has `notes` keyed by
      // partition instead — detected per-key, not per-file, so a file that's
      // itself mid-migration (part id-keyed from a previous load of this
      // exact file, part still partition-keyed because a session ID above
      // came from a legacy `sessions` entry with no `id`) migrates whatever
      // it still needs to. A key that doesn't match any restored session's
      // id (every id created above is either the exact one it was last saved
      // with, or freshly minted for a legacy entry with no `id` — a legacy
      // key genuinely cannot collide with either) but does match a live
      // partition is legacy: applied once to the first restored session of
      // that partition, since nothing on disk says which of several
      // same-partition tabs it originally belonged to. The next save writes
      // it back id-keyed, converging permanently since ids stop churning
      // from that point on.
      if (notes && typeof notes === 'object') {
        const liveIds = new Set(restored.map(r => r.sess.id));
        const migratedPartitions = new Set<string>();
        for (const [key, note] of Object.entries(notes as Record<string, string>)) {
          if (!note) continue;
          if (liveIds.has(key)) { this.sessionNotes.set(key, note); continue; }
          if (migratedPartitions.has(key)) continue;
          const match = restored.find(r => r.partition === key);
          if (match) {
            this.sessionNotes.set(match.sess.id, note);
            migratedPartitions.add(key);
          }
        }
      }
      const first = this.sessions.values().next().value as TestSession | undefined;
      if (first) this.switchTo(first.id);
      return true;
    } catch { return false; }
  }

  // #229: public and called unconditionally by index.ts on every startup
  // (previously only ran from inside loadAndRestoreSessions(), so a user who
  // started with no saved tabs never got old recordings cleaned up).
  async cleanupOldRecordings(maxAgeDays = 30) {
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
          if (stat.mtimeMs < cutoff) {
            // The base file plus its WAL/SHM siblings (present only while
            // the DB was open in WAL mode) — a sibling that never existed
            // or was already checkpointed away is expected, not an error.
            for (const suffix of ['', '-wal', '-shm']) {
              try { await fs.promises.unlink(`${fp}${suffix}`); } catch {}
            }
          }
        // silent: stat/unlink race on one stale recording file among possibly many — not worth a warn per file
        } catch {}
      }
    } catch (e) {
      this.log.warn('sessions', 'Failed to clean up old recordings', { error: String(e) });
    }
  }

  /** For the recording:status IPC / the timeline's eviction banner. */
  getRecordingStatus(id: string): { cap: number; evictedAt: number | null; evictedCount: number } | null {
    return this.sessions.get(id)?.recorder.getStatus() ?? null;
  }

  /** #262: for the "Load older events" button — the lowest event id still
   *  stored for this session, so the timeline can tell it's reached the
   *  beginning instead of guessing from an empty page. */
  getOldestEventId(id: string): number | null {
    return this.sessions.get(id)?.recorder.getOldestId() ?? null;
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

  // #269: a clone is meant to be an independent copy of the source tab "as it
  // currently is" — cookies (with sameSite), localStorage/sessionStorage/
  // IndexedDB, emulation overrides and the current URL, in addition to the
  // mock/resilience rules already copied below. Every copy step is awaited
  // and its failures collected into `warnings` rather than swallowed, so a
  // partial clone doesn't look identical to a full one.
  async cloneSession(sourceId: string, newName: string): Promise<{ session: TestSession; warnings: string[] } | null> {
    const src = this.sessions.get(sourceId);
    if (!src) return null;
    const warnings: string[] = [];
    const dest = this.createSession(newName, { persistent: src.persistent });
    // createSession() already seeded dest.partition with []; overwrite with
    // a deep copy so editing either side afterward doesn't affect the other.
    this.mockManager.cloneInto(dest.partition, src.partition);
    this.resilienceManager.cloneInto(dest.partition, src.partition);
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
          secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate, sameSite: c.sameSite,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`cookie '${c.name}': ${msg}`);
        this.log.warn('sessions', `Failed to copy cookie '${c.name}' while cloning`, { sessionId: dest.id, error: msg });
      }
    }

    const srcEmulation = this.getEmulation(sourceId);
    if (srcEmulation) {
      const errors = await this.setEmulation(dest.id, { ...srcEmulation });
      for (const [field, msg] of Object.entries(errors)) warnings.push(`emulation ${field}: ${msg}`);
    }

    // localStorage/sessionStorage/IndexedDB + navigation only apply when the
    // source has a real page loaded — a tab still on the new-tab page has
    // nothing page-scoped to seed, and the clone already opens on the
    // new-tab page itself (createSession()'s default with no startUrl).
    if (src.currentUrl) {
      let collected: Pick<FrameSnapshot, 'localStorage' | 'sessionStorage' | 'indexedDB' | 'warnings'> | undefined;
      try {
        const raw = await src.view.webContents.mainFrame.executeJavaScript(COLLECT_FRAME_SCRIPT) as string;
        collected = JSON.parse(raw) as FrameSnapshot;
      } catch (e) {
        warnings.push(`storage collection: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (collected?.warnings?.length) warnings.push(...collected.warnings.map((w) => `storage collection: ${w}`));

      // Seed the clone's localStorage/sessionStorage/IndexedDB via a one-shot
      // CDP script BEFORE navigating, the same #243 ordering fix
      // restoreSnapshot() uses — otherwise the destination page's own
      // bootstrap JS (e.g. reading auth state out of localStorage on load)
      // would run against empty storage.
      const dbg = dest.view.webContents.debugger;
      let preloadScriptId: string | undefined;
      if (collected) {
        try {
          await dbg.sendCommand('Page.enable');
          const result = await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
            source: buildRestoreFrameScript({
              url: src.currentUrl,
              localStorage: collected.localStorage,
              sessionStorage: collected.sessionStorage,
              indexedDB: collected.indexedDB,
            }),
          }) as { identifier: string };
          preloadScriptId = result?.identifier;
        } catch (e) {
          warnings.push(`storage seed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      await dest.view.webContents.loadURL(src.currentUrl);
      await waitForFrameLoad(dest.view.webContents);

      if (preloadScriptId) {
        await dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: preloadScriptId })
          .catch((e) => this.warnCdpFailure(dest.id, 'Page.removeScriptToEvaluateOnNewDocument', e));
      }
    }

    this.log.info('sessions', `Session cloned from ${sourceId}`, { sessionId: dest.id, warnings: warnings.length });
    return { session: dest, warnings };
  }

  navigate(id: string, url: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.view.webContents.loadURL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  }

  getTimeline(id: string, opts?: { limit?: number; since?: number; sinceId?: number }) {
    return this.sessions.get(id)?.recorder.getTimeline(opts) ?? [];
  }

  // #261: CDP omits `postData` inline on Network.requestWillBeSent for
  // large/multipart bodies (`hasPostData: true` with no `postData`) — the
  // detail panel calls this to fetch it on demand. The request may already be
  // gone from Chromium's own buffer by the time this is called (the debugger
  // has to still be attached and the request still tracked internally), in
  // which case Network.getRequestPostData rejects — that's surfaced as
  // `postData: undefined`, not thrown, so the caller shows a plain "no longer
  // available" message instead of an error.
  async getRequestPostData(id: string, requestId: string): Promise<{ postData?: string }> {
    const s = this.sessions.get(id);
    if (!s) return { postData: undefined };
    try {
      const result = await s.view.webContents.debugger.sendCommand('Network.getRequestPostData', { requestId }) as { postData?: string };
      return { postData: result?.postData };
    } catch (e) {
      this.warnCdpFailure(id, 'Network.getRequestPostData', e);
      return { postData: undefined };
    }
  }

  getLoadedDomains(id: string): string[] {
    return Array.from(this.sessions.get(id)?.loadedDomains ?? []);
  }

  // ── Session snapshots (#255: storage/CDP logic lives in SnapshotManager) ──

  async exportSnapshotDialog(id: string): Promise<void> {
    return this.snapshotManager.exportSnapshotDialog(id);
  }

  async importSnapshotDialog(id: string): Promise<void> {
    return this.snapshotManager.importSnapshotDialog(id);
  }

  async importSessionAsNewDialog(): Promise<void> {
    return this.snapshotManager.importSessionAsNewDialog();
  }

  private showSnapshotWarnings(title: string, warnings: string[]): void {
    this.snapshotManager.showSnapshotWarnings(title, warnings);
  }

  // #232: builds from every stored network-* row for the session (via
  // SessionRecorder.getAllNetworkRows()), not just whatever window the
  // renderer's own timeline currently has loaded.
  async exportHarDialog(id: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: 'Session not found' };

    const rows = s.recorder.getAllNetworkRows();
    const har = buildHar(rows, { creatorVersion: app.getVersion(), pageUrl: s.currentUrl });

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const safeName = s.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'session';

    const result = await dialog.showSaveDialog(this.win, {
      title: 'Export HAR',
      defaultPath: `${safeName}-${stamp}.har`,
      filters: [{ name: 'HAR', extensions: ['har'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    try {
      fs.writeFileSync(result.filePath, JSON.stringify(har, null, 2));
      this.log.info('sessions', 'HAR exported', { sessionId: id });
      return { ok: true, path: result.filePath };
    } catch (e) {
      this.log.warn('sessions', 'HAR export failed', { sessionId: id, error: String(e) });
      return { ok: false, error: String(e) };
    }
  }

  // --- Evidence for the Jira "Attach" group (#245) ---

  async capturePageScreenshot(id: string): Promise<Buffer | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    try {
      const img = await s.view.webContents.capturePage();
      return img.toPNG();
    } catch (e) {
      this.log.warn('sessions', 'Failed to capture screenshot for Jira attachment', { sessionId: id, error: String(e) });
      return null;
    }
  }

  // HAR built from every stored network-* row at or after sinceTs (or the
  // full history when sinceTs is null) — the same buildHar() the manual
  // "Export HAR" button uses (#232), just returned as a string instead of
  // written to a file.
  buildHarSince(id: string, sinceTs: number | null): string | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const rows = s.recorder.getAllNetworkRows();
    const filtered = sinceTs != null ? filterRowsSince(rows, sinceTs) : rows;
    const har = buildHar(filtered, { creatorVersion: app.getVersion(), pageUrl: s.currentUrl });
    return JSON.stringify(har, null, 2);
  }

  getConsoleErrorRows(id: string) {
    return this.sessions.get(id)?.recorder.getConsoleErrorRows() ?? [];
  }

  // The active tab's *current* in-progress recording if one is running,
  // else its most recently *stopped* recording — "current or most recent"
  // per #245's acceptance criteria. Empty when neither exists.
  getEvidenceSteps(id: string): TestStep[] {
    return this.recordingManager.getEvidenceSteps(id);
  }

  // ─────────────────────────────────────────────────────────────────────────

  private injectTestData(view: WebContentsView, value: string) {
    const escaped = JSON.stringify(value);
    view.webContents.executeJavaScript(`
      (function(){
        ${NATIVE_SET_VALUE_FN}
        var el=document.activeElement;
        if(!el||!('value' in el))return;
        __tbSetNativeValue(el,${escaped});
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

  // #241: emulation storage/CDP dispatch lives in EmulationManager (#255).
  async setEmulation(id: string, opts: EmulationPatch): Promise<Record<string, string>> {
    return this.emulationManager.setEmulation(id, opts);
  }

  getEmulation(id: string): EmulationOverrides | null {
    return this.emulationManager.getEmulation(id);
  }

  // #265: per-tab (not per-partition — a sibling tab in the same session
  // starts unthrottled, matching the acceptance criteria) network/CPU
  // throttling. Unlike setEmulation() above, there's nothing here that can
  // meaningfully "half apply": both CDP commands are simple, idempotent
  // setters with no earlier-state to preserve on partial failure, so this
  // just applies both and stores whichever the caller asked for regardless
  // of whether a given command's promise resolves — a failed command still
  // leaves the debugger in whatever state it was already in, and the next
  // did-navigate re-application (below) will retry it.
  private async applyConditions(id: string, c: TabConditions): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    const dbg = s.view.webContents.debugger;
    await dbg.sendCommand('Network.emulateNetworkConditions', toCdpNetworkConditions(c.network))
      .catch((e) => this.warnCdpFailure(id, 'Network.emulateNetworkConditions', e));
    await dbg.sendCommand('Emulation.setCPUThrottlingRate', { rate: c.cpuRate })
      .catch((e) => this.warnCdpFailure(id, 'Emulation.setCPUThrottlingRate', e));
  }

  async setConditions(id: string, c: TabConditions): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    // Applied before being stored, so a caller that awaits this (and the
    // tests that poll getConditions()/throttleLabel afterward) can rely on
    // the CDP commands having actually landed once this resolves.
    await this.applyConditions(id, c);
    s.conditions = c;
    this.onSessionsChanged();
  }

  getConditions(id: string): TabConditions | null {
    return this.sessions.get(id)?.conditions ?? null;
  }

  // #266: null for a session that doesn't exist, or whose current document
  // isn't http:/https: (file:, the new-tab page, …) — the popover shows
  // nothing for those. Cert fields come back all-empty/zero for an http:
  // page (no certificate) or before the first Security event arrives; the
  // renderer tells those two apart from the URL scheme it already tracks.
  getSecurityPageState(id: string): SecurityPageState | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    let scheme = '';
    try { if (s.currentUrl) scheme = new URL(s.currentUrl).protocol; } catch {} // silent: currentUrl is Electron's own just-navigated-to URL
    if (scheme !== 'https:' && scheme !== 'http:') return null;
    const cert = s.securityState;
    return {
      protocol: cert?.protocol ?? '',
      keyExchange: cert?.keyExchange ?? '',
      cipher: cert?.cipher ?? '',
      subjectName: cert?.subjectName ?? '',
      issuer: cert?.issuer ?? '',
      validFrom: cert?.validFrom ?? 0,
      validTo: cert?.validTo ?? 0,
      mixedContentUrls: s.mixedContentUrls,
    };
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

  // ── Accessibility (#255: collector scripts/CDP orchestration live in A11yService) ──

  async getA11yTree(id: string): Promise<object[] | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    try { return await this.a11yService.getA11yTree(s.view.webContents); } catch { return null; }
  }

  async setA11yInspect(id: string, enabled: boolean): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.a11yInspecting = enabled;
    try {
      if (enabled) await this.a11yService.setInspectEnabled(s.view.webContents);
      else await this.a11yService.setInspectDisabled(s.view.webContents);
    } catch (e) {
      this.log.warn('sessions', enabled ? 'Failed to enable a11y inspect bindings' : 'Failed to disable a11y inspect bindings', { sessionId: id, error: String(e) });
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
    if (!enabled) {
      try {
        await this.a11yService.disableFocusOverlay(s.view.webContents);
      } catch (e) {
        this.log.warn('sessions', 'Failed to disable a11y focus overlay', { sessionId: id, error: String(e) });
      }
      return null;
    }
    try {
      return await this.a11yService.enableFocusOverlay(s.view.webContents);
    } catch {
      return null;
    }
  }

  async detectA11yFocusTrap(id: string): Promise<FocusTrapResult | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    return this.a11yService.detectFocusTrap(id, s.view.webContents);
  }

  async getA11yViolations(id: string): Promise<A11yViolationsResult> {
    const s = this.sessions.get(id);
    if (!s) {
      const error = `No such session: ${id}`;
      this.log.error('sessions', `A11y violations audit failed: ${error}`, { sessionId: id });
      return { ok: false, error };
    }
    const result = await this.a11yService.getViolations(s.view.webContents);
    if (result.ok === false) this.log.error('sessions', `A11y violations audit failed: ${result.error}`, { sessionId: id });
    return result;
  }

  // Scrolls to and briefly outlines the element a violation node points at.
  // Selector comes from axe's own `target` array — single-frame, single-
  // selector targets only (see renderer/a11y.js for the multi-frame/shadow-
  // DOM cases this deliberately doesn't handle).
  async highlightA11yElement(id: string, selector: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    return this.a11yService.highlightElement(s.view.webContents, selector);
  }

  async getContrastIssues(id: string): Promise<ContrastIssue[] | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    return this.a11yService.getContrastIssues(s.view.webContents);
  }

  // Highlights an AX node by its backendDOMNodeId (present on every CDP
  // Accessibility.AXNode) — used by the Structure view, which works from
  // whatever the accessibility tree already carries rather than resolving a
  // CSS selector, so it doesn't depend on the Tree view having been opened.
  async highlightA11yNode(id: string, backendDOMNodeId: number): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    return this.a11yService.highlightNode(s.view.webContents, backendDOMNodeId);
  }

  async getAltLabelIssues(id: string): Promise<AltLabelIssues | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    return this.a11yService.getAltLabelIssues(s.view.webContents);
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

  async getSessionStorage(id: string): Promise<Record<string, string>> {
    const s = this.sessions.get(id);
    if (!s) return {};
    try {
      const raw = await s.view.webContents.executeJavaScript(
        'JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)))'
      );
      return JSON.parse(raw) ?? {};
    } catch { return {}; }
  }

  async getIndexedDB(id: string): Promise<IndexedDBSnapshot> {
    const s = this.sessions.get(id);
    if (!s) return {};
    try {
      const raw = await s.view.webContents.executeJavaScript(COLLECT_INDEXEDDB_SCRIPT);
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

  // #236: unlike mock/resilience rules (a property of the partition), hung
  // requests are a property of the *tab* whose CDP debugger actually paused
  // them — keyed by session id, lazily created.
  private hungRequestsForSession(id: string): Map<string, ReturnType<typeof setTimeout> | null> {
    let map = this.hungRequests.get(id);
    if (!map) { map = new Map(); this.hungRequests.set(id, map); }
    return map;
  }

  // Mock/Resilience rules live in MockManager/ResilienceManager (#255),
  // keyed by the session's stable partition rather than the per-tab id
  // these methods still take from the renderer — every method below
  // resolves id → partition once and delegates the actual storage/matching
  // to the owning manager, same composition pattern as downloadManager/
  // permissionManager above.
  getMockRules(id: string): MockRule[] {
    const partition = this.sessions.get(id)?.partition;
    return partition ? this.mockManager.getRules(partition) : [];
  }

  // #233: shared by the Fetch.requestPaused handler above and the
  // recording:replay IPC, so a replay is intercepted by exactly the same
  // rules (and matching semantics) a live request from that tab would be.
  findMatchingMockRule(id: string, method: string, url: string): MockRule | null {
    const partition = this.sessions.get(id)?.partition;
    return partition ? this.mockManager.findMatch(partition, method, url) : null;
  }

  getPartition(id: string): string | null {
    return this.sessions.get(id)?.partition ?? null;
  }

  addMockRule(id: string, rule: MockRule): void {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return;
    this.mockManager.add(partition, rule);
    this._applyMocks(id);
    this.log.info('mock', `Mock rule added: ${rule.method} ${rule.urlPattern}`, { sessionId: id });
  }

  removeMockRule(id: string, ruleId: string): void {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return;
    this.mockManager.remove(partition, ruleId);
    this._applyMocks(id);
    this.log.info('mock', `Mock rule removed: ${ruleId}`, { sessionId: id });
  }

  toggleMockRule(id: string, ruleId: string, enabled: boolean): void {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return;
    this.mockManager.toggle(partition, ruleId, enabled);
    this._applyMocks(id);
    this.log.info('mock', `Mock rule ${enabled ? 'enabled' : 'disabled'}: ${ruleId}`, { sessionId: id });
  }

  // Returns whether the update actually applied — #235: the renderer needs
  // to tell "saved" apart from "silently did nothing" (the owning tab was
  // closed since the edit row was opened, or the rule itself is gone) so it
  // can show an inline error instead of pretending the edit went through.
  updateMockRule(id: string, ruleId: string, patch: Partial<MockRule>): boolean {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return false;
    const ok = this.mockManager.update(partition, ruleId, patch);
    if (ok) this._applyMocks(id);
    return ok;
  }

  // #263: rules are matched in array order (findMatchingMockRule's own
  // `.find()`) — this is what makes that order visible/controllable from the
  // panel instead of only settable by deleting and recreating rules.
  moveMockRule(id: string, ruleId: string, dir: 'up' | 'down'): void {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return;
    this.mockManager.move(partition, ruleId, dir);
    this._applyMocks(id);
    this.log.info('mock', `Mock rule moved ${dir}: ${ruleId}`, { sessionId: id });
  }

  // #264: id/hitCount/lastHitAt are run-local, not something a shared rule
  // set should carry — the exported file only has what's needed to recreate
  // the rules elsewhere.
  async exportMockRules(id: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
    if (!this.sessions.get(id)) return { ok: false, error: 'Session not found' };
    const rules = this.getMockRules(id);
    const result = await this.mockManager.exportRulesToFile(rules);
    if (result.ok) this.log.info('mock', `Mock rules exported: ${rules.length}`, { sessionId: id });
    else if (result.error) this.log.warn('mock', 'Mock rules export failed', { sessionId: id, error: result.error });
    return result;
  }

  // #264: valid rules are appended (with fresh ids) to the active tab's
  // partition — an import never replaces or reorders what's already there.
  async importMockRules(id: string): Promise<{ ok: boolean; imported?: number; skipped?: number; firstSkipReason?: string; canceled?: boolean; error?: string }> {
    const picked = await this.mockManager.promptAndValidateImportFile();
    if ('canceled' in picked) return { ok: false, canceled: true };
    if ('error' in picked) return { ok: false, error: picked.error };

    const partition = this.sessions.get(id)?.partition;
    if (!partition) return { ok: false, error: 'Session not found' };
    const imported = this.mockManager.appendImportedRules(partition, picked.rules);
    if (imported > 0) this._applyMocks(id); // also persists
    this.log.info('mock', `Mock rules imported: ${imported} (skipped ${picked.skipped.length})`, { sessionId: id });
    return { ok: true, imported, skipped: picked.skipped.length, firstSkipReason: picked.skipped[0]?.reason };
  }

  private _applyFetch(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const dbg = s.view.webContents.debugger;
    const activeMocks = this.mockManager.getEnabledRules(s.partition);
    const activeRes = this.resilienceManager.getEnabledRules(s.partition);
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

  // #264: every caller of this (the 5 Mock rule mutators — add/remove/
  // toggle/update/move) is a rule-set change, so persisting here too means a
  // crash (not just a graceful quit) never loses a persistent tab's rules.
  // Resilience rule mutators call _applyFetch directly, bypassing this —
  // persisting those rules is explicitly out of scope for #264.
  private _applyMocks(id: string): void {
    this._applyFetch(id);
    this.saveSessions();
  }

  getResilienceRules(id: string): ResilienceRule[] {
    const partition = this.sessions.get(id)?.partition;
    return partition ? this.resilienceManager.getRules(partition) : [];
  }

  addResilienceRule(id: string, rule: ResilienceRule): void {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return;
    this.resilienceManager.add(partition, rule);
    this._applyFetch(id);
    this.log.info('resilience', `Resilience rule added: ${rule.urlPattern}`, { sessionId: id });
  }

  removeResilienceRule(id: string, ruleId: string): void {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return;
    this.resilienceManager.remove(partition, ruleId);
    this._applyFetch(id);
    this.log.info('resilience', `Resilience rule removed: ${ruleId}`, { sessionId: id });
  }

  toggleResilienceRule(id: string, ruleId: string, enabled: boolean): void {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return;
    const rule = this.resilienceManager.toggle(partition, ruleId, enabled);
    if (rule) {
      this._applyFetch(id);
      this.log.info('resilience', `Resilience rule ${enabled ? 'enabled' : 'disabled'}: ${ruleId}`, { sessionId: id });
    }
  }

  updateResilienceRule(id: string, ruleId: string, patch: Partial<ResilienceRule>): void {
    const partition = this.sessions.get(id)?.partition;
    if (!partition) return;
    const rule = this.resilienceManager.update(partition, ruleId, patch);
    if (rule) this._applyFetch(id);
  }

  destroySession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const p of this.followAlongManager.listFollowPairings()) {
      if (p.leaderId === id || p.followerId === id) {
        this.followAlongManager.stopFollowAlong(p.leaderId)
          .catch((e) => this.log.warn('sessions', 'Failed to stop Follow Along pairing during session destroy', { sessionId: id, error: String(e) }));
      }
    }
    if (this.activeId === id) { this.win.contentView.removeChildView(s.view); this.activeId = null; }
    // #276: a permission prompt still pending for this exact tab can no
    // longer be meaningfully answered — auto-deny and remove it (not
    // persisted; the tester never actually chose it) before the webContents
    // it belongs to is gone.
    this.permissionManager.dismissForWebContents(s.view.webContents.id);
    s.recorder.destroy();
    (s.view.webContents as any).destroy?.();
    this.sessions.delete(id);
    this.sessionNotes.delete(id);
    this.recordingManager.cleanupSession(id);
    this.playingIds.delete(id);
    this.emulationManager.cleanupSession(id);
    this.sessionHistory.delete(id);
    // #276: an in-memory session's permission grants/denials are meant to
    // leave no trace — but only once truly gone. A middle-clicked tab can
    // share its partition with a still-open sibling (session colour
    // inheritance), so this only wipes when no other live session is still
    // using the same partition.
    if (!s.persistent && !Array.from(this.sessions.values()).some((o) => o.partition === s.partition)) {
      this.permissionManager.clearPartition(s.partition);
    }
    const hung = this.hungRequests.get(id);
    if (hung) {
      for (const timer of hung.values()) if (timer) clearTimeout(timer);
      this.hungRequests.delete(id);
    }
    this.onSessionsChanged();
    this.log.info('sessions', 'Session destroyed', { sessionId: id });
  }


  // ── Record/Playback (#255: mechanics live in RecordingManager) ───────────

  async pollRecordingSteps(id: string): Promise<TestStep[]> {
    return this.recordingManager.pollRecordingSteps(id);
  }

  async startRecording(id: string): Promise<boolean> {
    return this.recordingManager.startRecording(id);
  }

  async stopRecording(id: string): Promise<TestStep[]> {
    return this.recordingManager.stopRecording(id);
  }

  async playbackStep(id: string, step: TestStep): Promise<{ success: boolean; error?: string }> {
    return this.recordingManager.playbackStep(id, step);
  }

  // Returns how many elements on the session's current page match `selector`,
  // or -1 if the selector itself is invalid — used to flag fragile recorded
  // selectors (0 matches = broken, >1 = ambiguous) before/while a test runs.
  async countSelectorMatches(id: string, selector: string): Promise<number> {
    return this.recordingManager.countSelectorMatches(id, selector);
  }

  // ── Follow Along (#255: mechanics live in FollowAlongManager) ────────────

  async startFollowAlong(
    leaderId: string, followerId: string, mirrorNavigation: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    return this.followAlongManager.startFollowAlong(leaderId, followerId, mirrorNavigation);
  }

  async stopFollowAlong(leaderId: string): Promise<boolean> {
    return this.followAlongManager.stopFollowAlong(leaderId);
  }

  setFollowMirrorNavigation(leaderId: string, mirrorNavigation: boolean): boolean {
    return this.followAlongManager.setFollowMirrorNavigation(leaderId, mirrorNavigation);
  }

  listFollowPairings(): { leaderId: string; followerId: string; mirrorNavigation: boolean }[] {
    return this.followAlongManager.listFollowPairings();
  }
}
