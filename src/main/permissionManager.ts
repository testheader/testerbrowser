import { BrowserWindow, WebContents } from 'electron';
import { JsonStore } from './jsonFile';

function getHostname(url: string): string {
  try { return new URL(url).hostname || ''; } catch { return ''; }
}

// #276: a genuinely malformed requestingUrl/requestingOrigin (rare) used to
// fall back to the empty string — the request handler stored a grant under
// the key `${partition}|`, but the check handler looks it up under
// `${partition}|${requestingOrigin}` using whatever Electron itself passes
// as requestingOrigin for a malformed URL, which is very unlikely to also be
// ''. The grant then silently never matched again. Falling back to the raw
// (trimmed) string instead is self-consistent: applied identically to
// requestingUrl in the request handler and to requestingOrigin in the check
// handler, the exact same malformed value produces the exact same key on
// both paths, even though neither is a "real" origin.
export function originKeyFor(requestingUrlOrOrigin: string): string {
  try { return new URL(requestingUrlOrOrigin).origin; } catch { return `malformed:${(requestingUrlOrOrigin || '').trim()}`; }
}

export interface PermissionRecord {
  partition: string;
  origin: string;
  permission: string;
  status: 'granted' | 'denied';
  updatedAt: number;
}

const PENDING_TIMEOUT_MS = 60_000;

interface PendingEntry {
  callback: (granted: boolean) => void;
  permission: string;
  partition: string;
  origin: string;
  webContentsId: number;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionManager {
  private win: BrowserWindow;
  private pendingPermissions = new Map<string, PendingEntry>();
  private store: JsonStore<PermissionRecord[]>;
  // Set by SessionManager so a prompt can name the tab it belongs to — kept
  // as an injected lookup rather than PermissionManager knowing about
  // TestSession itself, since all it actually needs is one id string.
  private getSessionIdForWebContents: (webContentsId: number) => string | null;

  constructor(win: BrowserWindow, getSessionIdForWebContents: (webContentsId: number) => string | null = () => null) {
    this.win = win;
    this.getSessionIdForWebContents = getSessionIdForWebContents;
    this.store = new JsonStore<PermissionRecord[]>('permissions.json', []);
  }

  private recordedStatus(partition: string, origin: string, permission: string): 'granted' | 'denied' | null {
    return this.store.get().find(
      (r) => r.partition === partition && r.origin === origin && r.permission === permission
    )?.status ?? null;
  }

  attach(ses: Electron.Session, partition: string) {
    ses.setPermissionRequestHandler((wc: WebContents, permission, callback, details) => {
      if (permission === 'fullscreen' || permission === 'pointerLock') {
        callback(true);
        return;
      }
      const requestingUrl = details?.requestingUrl ?? '';
      const origin = originKeyFor(requestingUrl);

      // #276: a remembered denial answers immediately too, same as a
      // remembered grant already did — previously only grants were
      // persisted, so a denied permission re-prompted on every single
      // subsequent request for the same origin.
      const remembered = this.recordedStatus(partition, origin, permission);
      if (remembered) { callback(remembered === 'granted'); return; }

      const originLabel = getHostname(requestingUrl) || origin || 'This page';
      const reqId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // #276: an unanswered prompt used to sit forever — auto-deny (without
      // persisting the denial; the tester never actually chose it) once
      // nobody responds within a reasonable window.
      const timer = setTimeout(() => this.dismiss(reqId, false), PENDING_TIMEOUT_MS);
      this.pendingPermissions.set(reqId, { callback, permission, partition, origin, webContentsId: wc.id, timer });

      const sessionId = this.getSessionIdForWebContents(wc.id);
      this.win.webContents.send('permission:request', { reqId, permission, origin: originLabel, sessionId });
    });

    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      // #276: requestingOrigin is put through the same fallback as
      // requestingUrl above — see originKeyFor's comment for why.
      const origin = originKeyFor(requestingOrigin);
      return this.recordedStatus(partition, origin, permission) === 'granted';
    });
  }

  respond(reqId: string, granted: boolean) {
    const entry = this.pendingPermissions.get(reqId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.callback(granted);
    this.persist(entry.partition, entry.origin, entry.permission, granted ? 'granted' : 'denied');
    this.pendingPermissions.delete(reqId);
  }

  // Auto-dismiss paths (timeout, tab closed) — never persists a denial the
  // tester never actually chose, just answers the live callback and drops
  // the pending entry, then tells the renderer to remove that one prompt if
  // it's still showing.
  private dismiss(reqId: string, granted: boolean) {
    const entry = this.pendingPermissions.get(reqId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.callback(granted);
    this.pendingPermissions.delete(reqId);
    this.win.webContents.send('permission:dismiss', { reqId });
  }

  // Called from SessionManager.destroySession for every destroyed session
  // (persistent or not) — a prompt belonging to a tab that just closed can
  // no longer be meaningfully answered, and its callback would otherwise
  // reference a webContents that's about to be gone.
  dismissForWebContents(webContentsId: number) {
    for (const reqId of Array.from(this.pendingPermissions.keys())) {
      if (this.pendingPermissions.get(reqId)?.webContentsId === webContentsId) this.dismiss(reqId, false);
    }
  }

  private persist(partition: string, origin: string, permission: string, status: 'granted' | 'denied') {
    this.store.update((all) => {
      const next = all.filter((r) => !(r.partition === partition && r.origin === origin && r.permission === permission));
      next.push({ partition, origin, permission, status, updatedAt: Date.now() });
      return next;
    });
  }

  // Revocation UI: lists everything remembered for one partition (a saved
  // grant or denial), newest first.
  list(partition: string): PermissionRecord[] {
    return this.store.get()
      .filter((r) => r.partition === partition)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // A revoked entry just goes back to "will prompt again next time" — it
  // isn't replaced with anything, just removed.
  revoke(partition: string, origin: string, permission: string): boolean {
    const before = this.store.get();
    const after = before.filter((r) => !(r.partition === partition && r.origin === origin && r.permission === permission));
    if (after.length === before.length) return false;
    this.store.set(after);
    return true;
  }

  // #276: only ever called for an in-memory (non-persistent) session whose
  // partition has no other live session still using it — SessionManager
  // owns both of those checks (persistence, and whether a middle-click-
  // opened sibling tab shares the same partition) since PermissionManager
  // has no notion of TestSession. Wipes every persisted grant/denial for
  // that partition, matching "an in-memory tab leaves no trace."
  clearPartition(partition: string) {
    const before = this.store.get();
    const after = before.filter((r) => r.partition !== partition);
    if (after.length !== before.length) this.store.set(after);
  }
}
