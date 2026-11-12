import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { isTrustedNewtabFrame } from './newtabUrl';

// --- Default-deny IPC sender check ---
// Electron's ipcMain accepts a message from *any* renderer. The only renderer
// meant to drive the app is the chrome window (renderer/index.html, via
// src/preload/index.ts). Every tab is a WebContentsView showing a website under
// test; its preload (src/preload/newtab.ts) only exposes a few APIs, and only
// to the bundled new-tab page — but a hostile page that escaped its sandbox
// could still send any channel directly. So installIpcGuard() wraps
// ipcMain.handle/handleOnce once, at startup, and every channel — including
// ones added later — rejects senders other than:
//   - the chrome window's top-level frame: any channel;
//   - a top-level frame showing the bundled renderer/newtab.html
//     (isTrustedNewtabFrame): only NEWTAB_CHANNELS.
// ipcMain.on/once aren't wrapped (the app uses only invoke/handle);
// ipcGuard.test.ts fails if a registration through them appears.

// Exactly the channels src/preload/newtab.ts invokes. ipcGuard.test.ts fails
// if the two drift apart.
export const NEWTAB_CHANNELS: ReadonlySet<string> = new Set([
  'speeddial:get', 'speeddial:set',
  'favicons:get',
  'theme:get', 'theme:set',
  'bookmarks:list', 'bookmarks:remove', 'bookmarks:listFolders',
  'settings:get', 'settings:set',
  'app:versionInfo',
]);

type SenderEvent = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;

export function isAllowedIpcSender(channel: string, e: SenderEvent, appWebContents: WebContents | readonly WebContents[] | null): boolean {
  const frame = e.senderFrame;
  if (!frame || frame.parent) return false; // gone, or an iframe
  const chrome = appWebContents ? ([] as WebContents[]).concat(appWebContents as WebContents | WebContents[]) : [];
  if (chrome.includes(e.sender)) return true;
  return NEWTAB_CHANNELS.has(channel) && isTrustedNewtabFrame(frame);
}

export function senderOrigin(e: SenderEvent): string {
  try { return new URL(e.senderFrame?.url ?? '').origin; } catch { return 'unknown'; }
}

export interface IpcGuardOptions {
  // Every chrome window's webContents (#367), or null/empty before one exists.
  getAppWebContents: () => WebContents | readonly WebContents[] | null;
  onReject: (channel: string, origin: string) => void;
  // Called once per finished handler call. `outcome` is 'ok', 'failed' (the
  // handler returned `{ ok: false, error }`) or 'threw' (sync throw / rejected
  // promise). Never receives arguments or return values — they can carry
  // cookies, tokens or page data — only the channel, timing and error text.
  onCall?: (info: IpcCallInfo) => void;
}

export interface IpcCallInfo {
  channel: string;
  durationMs: number;
  outcome: 'ok' | 'failed' | 'threw';
  error?: string;
}

function failureOf(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as { ok?: unknown; error?: unknown };
  if (r.ok !== false) return undefined;
  return typeof r.error === 'string' && r.error ? r.error : 'ok:false';
}

function errText(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

// Must run before any ipcMain.handle() registration.
export function installIpcGuard(ipc: IpcMain, opts: IpcGuardOptions): void {
  const check = (channel: string, e: SenderEvent): boolean => {
    if (isAllowedIpcSender(channel, e, opts.getAppWebContents())) return true;
    opts.onReject(channel, senderOrigin(e));
    return false;
  };
  type InvokeListener = (e: IpcMainInvokeEvent, ...args: any[]) => unknown;
  const guard = (channel: string, listener: InvokeListener): InvokeListener =>
    (e, ...args) => {
      if (!check(channel, e)) throw new Error(`IPC '${channel}' rejected: untrusted sender`);
      const onCall = opts.onCall;
      if (!onCall) return listener(e, ...args);
      const started = Date.now();
      const done = (outcome: IpcCallInfo['outcome'], error?: string) => {
        try { onCall({ channel, durationMs: Date.now() - started, outcome, error }); } catch { /* instrumentation must never break a call */ }
      };
      let result: unknown;
      try {
        result = listener(e, ...args);
      } catch (err) {
        done('threw', errText(err));
        throw err;
      }
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<unknown>).then(
          (v) => { const f = failureOf(v); done(f ? 'failed' : 'ok', f); return v; },
          (err) => { done('threw', errText(err)); throw err; },
        );
      }
      const f = failureOf(result);
      done(f ? 'failed' : 'ok', f);
      return result;
    };

  const handle = ipc.handle.bind(ipc);
  const handleOnce = ipc.handleOnce.bind(ipc);
  ipc.handle = (channel, listener) => handle(channel, guard(channel, listener));
  ipc.handleOnce = (channel, listener) => handleOnce(channel, guard(channel, listener));
}
