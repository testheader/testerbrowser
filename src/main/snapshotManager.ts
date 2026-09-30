import { BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import type { AppLog } from './appLogger';
import { COLLECT_FRAME_SCRIPT, buildRestoreFrameScript } from './snapshotScripts';
// db name → { version, stores: { storeName → { keyPath, autoIncrement, records } } } —
// shared by session snapshots (FrameSnapshot.indexedDB below) and the live
// Storage panel's IndexedDB view (SessionManager.getIndexedDB(), which stays
// in sessionManager.ts — it's a general storage feature, not snapshot-
// specific). Type-only import, so this never becomes a runtime circular
// dependency between the two modules.
import type { IndexedDBSnapshot } from './sessionManager';

/**
 * Owns session snapshot export/import (#255, extracted from
 * sessionManager.ts once every snapshot/emulation-adjacent ticket in this
 * grooming batch — #243, #269, #241/#271 — had landed). A snapshot is a
 * captured copy of a tab's cookies + per-frame storage/IndexedDB/form/scroll/
 * history state, exported to and restored from a JSON file.
 *
 * SessionManager still owns tab lifecycle itself (createSession/switchTo/
 * destroySession) — importSessionAsNewDialog() needs those to create the
 * new tab a snapshot gets restored into, so they're injected narrowly via
 * `deps` rather than this class reaching back into SessionManager's own
 * session map.
 */

// One entry per frame (main frame + same-page iframes) inside a session
// snapshot. Storage/IndexedDB/history/scroll/fields are captured and
// restored; reactState is diagnostic-only (see snapshotScripts.ts) and is
// never fed back into a page on import.
export interface FrameSnapshot {
  url: string;
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  indexedDB?: IndexedDBSnapshot;
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

// Mirrors readSnapshotFile's real acceptance check — a file is importable if
// it has a frames array (v2), a cookies array, or a url, covering both the
// current multi-frame shape and the original v1 shape (single implicit
// frame, storage inline). Exported so tests exercise the real check instead
// of a locally reimplemented copy.
export function looksLikeImportableSnapshot(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const s = obj as Record<string, unknown>;
  return Array.isArray(s.frames) || Array.isArray(s.cookies) || typeof s.url === 'string';
}

// Resolves once the target webContents finishes (or fails) its next load, or
// after timeoutMs, whichever comes first. No `this` dependency, so it's a
// plain function shared by SessionManager.cloneSession() (which awaits a
// fresh tab's initial load) and SnapshotManager.restoreSnapshot() below
// (which awaits the snapshot's own URL loading) rather than being
// duplicated or living awkwardly on just one of the two classes.
export function waitForFrameLoad(wc: Electron.WebContents, timeoutMs = 10000): Promise<void> {
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

export interface SnapshotSessionRef {
  id: string;
  name: string;
  currentUrl: string;
  webContents: Electron.WebContents;
}

export interface SnapshotManagerDeps {
  createSession: (name: string) => { id: string };
  switchTo: (id: string) => void;
  destroySession: (id: string) => void;
}

export class SnapshotManager {
  private win: BrowserWindow;
  private log: AppLog;
  private getSession: (id: string) => SnapshotSessionRef | undefined;
  private deps: SnapshotManagerDeps;

  constructor(
    win: BrowserWindow,
    log: AppLog,
    getSession: (id: string) => SnapshotSessionRef | undefined,
    deps: SnapshotManagerDeps
  ) {
    this.win = win;
    this.log = log;
    this.getSession = getSession;
    this.deps = deps;
  }

  private warnCdpFailure(sessionId: string, command: string, e: unknown) {
    this.log.warn('sessions', `CDP command '${command}' failed`, { sessionId, error: String(e) });
  }

  async collectSnapshot(id: string): Promise<SessionSnapshot | null> {
    const s = this.getSession(id);
    if (!s) return null;
    const cookies = await s.webContents.session.cookies.get({});
    const warnings: string[] = [];
    const frames: FrameSnapshot[] = [];
    for (const frame of s.webContents.mainFrame.framesInSubtree) {
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
  async restoreSnapshot(id: string, snap: Record<string, unknown>): Promise<string[]> {
    const s = this.getSession(id);
    if (!s) return [];
    const warnings: string[] = [];

    if (Array.isArray(snap.cookies)) {
      await s.webContents.session.clearStorageData({ storages: ['cookies'] });
      for (const c of snap.cookies as Electron.Cookie[]) {
        const url = `${c.secure ? 'https' : 'http'}://${(c.domain ?? '').replace(/^\./, '')}${c.path ?? '/'}`;
        try {
          await s.webContents.session.cookies.set({ url, name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate, sameSite: c.sameSite });
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
      // Seed the main frame's localStorage/sessionStorage/IndexedDB via a
      // one-shot CDP script BEFORE navigating, so the page's own bootstrap
      // JS (e.g. an app reading auth state out of localStorage on load) runs
      // against the restored values instead of empty storage. Guarded to
      // only run in the top frame — addScriptToEvaluateOnNewDocument applies
      // to every frame of the target, and this snapshot's data belongs to
      // the main frame only. Subframes can't be pre-seeded this way (they
      // don't exist as separate CDP targets from here) and remain restored
      // post-load below — an accepted limitation. Form fields/scroll/history
      // still need a live DOM, so applyFrame() re-runs the full script
      // post-load anyway; re-seeding storage there is a harmless no-op repeat.
      const dbg = s.webContents.debugger;
      let preloadScriptId: string | undefined;
      if (mainFrameSnap) {
        try {
          await dbg.sendCommand('Page.enable');
          const result = await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
            source: `if (window.top === window.self) { ${buildRestoreFrameScript(mainFrameSnap)} }`,
          }) as { identifier: string };
          preloadScriptId = result?.identifier;
        } catch (e) {
          warnings.push(`pre-load storage seed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      await s.webContents.loadURL(snap.url);
      await waitForFrameLoad(s.webContents);

      if (preloadScriptId) {
        await dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: preloadScriptId })
          .catch((e) => this.warnCdpFailure(id, 'Page.removeScriptToEvaluateOnNewDocument', e));
      }

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

    await applyFrame(s.webContents.mainFrame, mainFrameSnap);
    const remaining = [...subframeSnaps];
    const liveSubframes = s.webContents.mainFrame.framesInSubtree.filter((f) => f !== s.webContents.mainFrame);
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

  showSnapshotWarnings(title: string, warnings: string[]): void {
    if (!warnings.length) return;
    dialog.showMessageBox(this.win, {
      type: 'warning',
      title,
      message: `Completed with ${warnings.length} warning(s):`,
      detail: warnings.slice(0, 20).join('\n') + (warnings.length > 20 ? `\n…and ${warnings.length - 20} more` : ''),
    });
  }

  async exportSnapshotDialog(id: string): Promise<void> {
    const confirm = await dialog.showMessageBox(this.win, {
      type: 'warning',
      title: 'Export session snapshot',
      message: 'This file will contain cookies, storage and other captured page data in plain text.',
      detail: 'Anyone with the exported file can read cookies (including session tokens), localStorage/sessionStorage contents and IndexedDB records captured from this session. Password fields are excluded, but other credentials the page stored may not be. Treat the file like a credential.',
      buttons: ['I understand, export…', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (confirm.response !== 0) return;

    const snap = await this.collectSnapshot(id);
    if (!snap) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const result = await dialog.showSaveDialog(this.win, {
      title: 'Export session snapshot',
      defaultPath: `snapshot-${ts}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!result.canceled && result.filePath) {
      try {
        fs.writeFileSync(result.filePath, JSON.stringify(snap, null, 2));
        this.showSnapshotWarnings('Export snapshot', snap.warnings);
        this.log.info('snapshot', 'Snapshot exported', { sessionId: id });
      } catch (e) {
        dialog.showErrorBox('Export failed', 'Could not write the snapshot file.');
        this.log.warn('snapshot', 'Snapshot export failed', { sessionId: id, error: String(e) });
      }
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
    const ns = this.deps.createSession(sessionName);
    try {
      const warnings = await this.restoreSnapshot(ns.id, snap);
      this.deps.switchTo(ns.id);
      this.win.webContents.send('session:newTab', { id: ns.id });
      this.showSnapshotWarnings('Import session', warnings);
    } catch {
      dialog.showErrorBox('Import failed', 'Could not apply the session snapshot.');
      this.deps.destroySession(ns.id);
    }
  }

  // Reads and validates a snapshot file, showing an error dialog and
  // returning null if it's missing, malformed, or not shaped like a
  // snapshot. Accepts both version 1 (legacy, single implicit frame) and
  // version 2 (multi-frame) shapes.
  readSnapshotFile(filePath: string): Record<string, unknown> | null {
    let snap: unknown;
    try {
      snap = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      dialog.showErrorBox('Import failed', 'The selected file is not valid JSON.');
      return null;
    }
    if (!looksLikeImportableSnapshot(snap)) {
      dialog.showErrorBox('Import failed', 'The selected file is not a valid session snapshot.');
      return null;
    }
    return snap as Record<string, unknown>;
  }
}
