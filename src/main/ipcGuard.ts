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
  'theme:get', 'theme:set',
  'bookmarks:list', 'bookmarks:remove', 'bookmarks:listFolders',
  'settings:get', 'settings:set',
  'app:versionInfo',
]);

type SenderEvent = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;

export function isAllowedIpcSender(channel: string, e: SenderEvent, appWebContents: WebContents | null): boolean {
  const frame = e.senderFrame;
  if (!frame || frame.parent) return false; // gone, or an iframe
  if (appWebContents && e.sender === appWebContents) return true;
  return NEWTAB_CHANNELS.has(channel) && isTrustedNewtabFrame(frame);
}

export function senderOrigin(e: SenderEvent): string {
  try { return new URL(e.senderFrame?.url ?? '').origin; } catch { return 'unknown'; }
}

export interface IpcGuardOptions {
  // The chrome window's webContents, or null before it exists.
  getAppWebContents: () => WebContents | null;
  onReject: (channel: string, origin: string) => void;
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
      return listener(e, ...args);
    };

  const handle = ipc.handle.bind(ipc);
  const handleOnce = ipc.handleOnce.bind(ipc);
  ipc.handle = (channel, listener) => handle(channel, guard(channel, listener));
  ipc.handleOnce = (channel, listener) => handleOnce(channel, guard(channel, listener));
}
