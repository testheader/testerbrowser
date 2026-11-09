import { ipcMain, net, session as electronSession } from 'electron';
import type { TestStep } from '../recordingManager';
import { buildMockFulfillParams } from '../mockManager';
import type { AppDeps } from './deps';

/** Console panel timeline/network-replay IPC, and Record/Playback/Follow Along step execution. */
export function registerRecordingIpc(deps: AppDeps): void {
  const { getSessionManager } = deps;

  ipcMain.handle('recording:timeline',  (e, id: string, opts) => getSessionManager(e)?.getTimeline(id, opts) ?? []);
  ipcMain.handle('recording:status',    (e, id: string) => getSessionManager(e)?.getRecordingStatus(id) ?? null);
  ipcMain.handle('recording:oldestId',  (e, id: string) => getSessionManager(e)?.getOldestEventId(id) ?? null);
  ipcMain.handle('recording:exportHar', (e, id: string) => getSessionManager(e)?.exportHarDialog(id) ?? { ok: false, error: 'No session manager' });
  ipcMain.handle('recording:getRequestPostData', (e, id: string, requestId: string) =>
    getSessionManager(e)?.getRequestPostData(id, requestId) ?? { postData: undefined }
  );

  // #233: replays used to always go through net.fetch — the app's own default
  // session — so a tab's Mock/Resilience rules, cookie jar and HTTP cache
  // never applied, and a redacted [REDACTED] header value got sent to the
  // server literally. sessionId routes this through the *originating tab's*
  // partition instead, and checks its Mock rules (via the exact matcher
  // Fetch.requestPaused itself uses) before touching the network — Resilience
  // is deliberately not applied here (see the ticket's "out of scope").
  ipcMain.handle('recording:replay', async (e, req: {
    sessionId?: string; method: string; url: string; headers: Record<string, string>; body?: string; timeoutMs?: number;
  }) => {
    const cleanHeaders = Object.fromEntries(Object.entries(req.headers || {}).filter(([, v]) => v !== '[REDACTED]'));

    const sm = getSessionManager(e);
    const mockRule = req.sessionId ? sm?.findMatchingMockRule(req.sessionId, req.method, req.url) : null;
    if (mockRule) {
      const fulfill = buildMockFulfillParams(mockRule, { headers: cleanHeaders });
      const headers: Record<string, string> = {};
      for (const h of fulfill.responseHeaders) headers[h.name] = h.value;
      return {
        ok: true,
        status: fulfill.responseCode,
        statusText: '',
        headers,
        body: Buffer.from(fulfill.body, 'base64').toString('utf-8'),
        servedBy: { mockRuleId: mockRule.id, urlPattern: mockRule.urlPattern },
      };
    }

    // Clamped to the overlay's own 1-600s input range as a backstop against a
    // malformed/absent value from the renderer.
    const timeoutMs = Math.min(Math.max(Math.round((req.timeoutMs ?? 30000)), 1000), 600000);
    try {
      const opts: RequestInit & { credentials?: 'omit' | 'same-origin' | 'include' } = {
        method: req.method,
        headers: cleanHeaders,
        // Cookies stay explicit — exactly what's in the overlay's Cookies
        // table (folded into a Cookie header by the renderer) — rather than
        // silently also sending whatever else is in the partition's own jar.
        credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (req.body && !['GET', 'HEAD'].includes(req.method.toUpperCase())) {
        opts.body = req.body;
      }
      const partition = req.sessionId ? sm?.getPartition(req.sessionId) : null;
      const fetcher = partition ? electronSession.fromPartition(partition) : net;
      const res = await fetcher.fetch(req.url, opts);
      const headers: Record<string, string> = {};
      res.headers.forEach((value: string, key: string) => { headers[key] = value; });
      const isImage = (headers['content-type'] || '').toLowerCase().startsWith('image/');
      if (isImage) {
        const buf = Buffer.from(await res.arrayBuffer());
        return { ok: true, status: res.status, statusText: res.statusText, headers, bodyBase64: buf.toString('base64') };
      }
      const body = await res.text();
      return { ok: true, status: res.status, statusText: res.statusText, headers, body };
    } catch (e: unknown) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        return { ok: false, error: `Timed out after ${Math.round(timeoutMs / 1000)} s` };
      }
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('session:startRecording',     (e, id: string) => getSessionManager(e)?.startRecording(id) ?? null);
  ipcMain.handle('session:stopRecording',      (e, id: string) => getSessionManager(e)?.stopRecording(id) ?? []);
  ipcMain.handle('session:pollRecordingSteps', (e, id: string) => getSessionManager(e)?.pollRecordingSteps(id) ?? []);
  // #245: the tab's current-or-most-recent recording, for the Jira bug
  // report's "Recorded steps" attachment checkbox to know whether there's
  // anything to enable/attach without side effects (unlike pollRecordingSteps,
  // this never harvests from the live page).
  ipcMain.handle('session:getEvidenceSteps',   (e, id: string) => getSessionManager(e)?.getEvidenceSteps(id) ?? []);
  ipcMain.handle('session:playbackStep',       (e, id: string, step: TestStep) => getSessionManager(e)?.playbackStep(id, step) ?? null);
  ipcMain.handle('session:setPlaybackActive',  (e, id: string, active: boolean) => getSessionManager(e)?.setPlaybackActive(id, active));
  ipcMain.handle('session:countSelectorMatches', (e, id: string, selector: string) => getSessionManager(e)?.countSelectorMatches(id, selector) ?? -1);

  ipcMain.handle('followalong:start', (e, leaderId: string, followerId: string, mirrorNavigation: boolean) =>
    getSessionManager(e)?.startFollowAlong(leaderId, followerId, mirrorNavigation) ?? { ok: false, error: 'No session manager' });
  ipcMain.handle('followalong:stop', (e, leaderId: string) => getSessionManager(e)?.stopFollowAlong(leaderId) ?? false);
  ipcMain.handle('followalong:setMirrorNavigation', (e, leaderId: string, mirrorNavigation: boolean) =>
    getSessionManager(e)?.setFollowMirrorNavigation(leaderId, mirrorNavigation) ?? false);
  ipcMain.handle('followalong:list', (e) => getSessionManager(e)?.listFollowPairings() ?? []);
}
