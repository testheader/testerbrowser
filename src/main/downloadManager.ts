import { BrowserWindow, shell } from 'electron';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { log } from './appLogger';

export interface DownloadInfo {
  id: string;
  filename: string;
  url: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
  savePath: string;
  // #247: which tab's session/partition triggered this download — set once
  // from attach()'s caller, at the partition level (several tabs can share
  // one partition, and will-download fires per-session, not per-tab, so
  // this is "the tab that first attached this partition", not necessarily
  // the exact tab behind every later download on it).
  sessionId: string;
  item?: Electron.DownloadItem;
}

// #367: Electron sessions are shared by every window, and will-download fires per
// session. So the hook is installed once per session across all windows' managers
// (not once per manager, which would record each download twice), and routes the
// download to the manager whose window owns the requesting tab.
const hookedSessions = new WeakSet<Electron.Session>();
const instances = new Set<DownloadManager>();

export interface DownloadRouting {
  ownsWebContents?: (webContentsId: number) => boolean;
  getSessionId?: (webContentsId: number) => string | null;
}

export class DownloadManager {
  private win: BrowserWindow;
  private downloads = new Map<string, DownloadInfo>();
  private routing: DownloadRouting;

  constructor(win: BrowserWindow, routing: DownloadRouting = {}) {
    this.win = win;
    this.routing = routing;
    instances.add(this);
  }

  /** Call when the window closes, so downloads are no longer routed to it. */
  dispose() { instances.delete(this); }

  attach(ses: Electron.Session, sessionId: string) {
    // Several tabs (and windows) can share one partition; hook will-download only once.
    if (hookedSessions.has(ses)) return;
    hookedSessions.add(ses);
    ses.on('will-download', (_event, item, webContents?: Electron.WebContents) => {
      const wcId = webContents?.id;
      const owner = (wcId !== undefined && Array.from(instances).find((m) => m.routing.ownsWebContents?.(wcId)))
        || (instances.has(this) ? this : Array.from(instances)[0] ?? this);
      // Attribute to the tab that actually started it when known, else the tab that first hooked this session.
      const attributed = (wcId !== undefined ? owner.routing.getSessionId?.(wcId) : null) ?? sessionId;
      owner.begin(item, attributed);
    });
  }

  private begin(item: Electron.DownloadItem, sessionId: string) {
    {
      const dlId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // path.basename strips any directory traversal from server-supplied filenames
      const rawName = path.basename(item.getFilename()) || 'download';
      const dlDir = app.getPath('downloads');
      const ext = path.extname(rawName);
      const base = path.basename(rawName, ext);
      let savePath = path.join(dlDir, rawName);
      let counter = 1;
      while (fs.existsSync(savePath)) {
        savePath = path.join(dlDir, `${base} (${counter++})${ext}`);
      }
      item.setSavePath(savePath);
      const filename = path.basename(savePath);

      const dl: DownloadInfo = {
        id: dlId, filename, url: item.getURL(),
        state: 'progressing', receivedBytes: 0,
        totalBytes: item.getTotalBytes(), savePath, sessionId, item,
      };
      this.downloads.set(dlId, dl);
      log.info('downloads', `Download started: ${filename}`, { sessionId, url: dl.url, totalBytes: dl.totalBytes });
      this.push(dl);

      item.on('updated', (_e, state) => {
        if (state === 'interrupted' && dl.state !== 'interrupted') {
          log.warn('downloads', `Download interrupted: ${filename}`, { sessionId, receivedBytes: item.getReceivedBytes() });
        }
        dl.state = state as 'progressing' | 'interrupted';
        dl.receivedBytes = item.getReceivedBytes();
        dl.totalBytes = item.getTotalBytes();
        this.push(dl);
      });
      item.on('done', (_e, state) => {
        dl.state = state as 'completed' | 'cancelled' | 'interrupted';
        dl.receivedBytes = item.getReceivedBytes();
        dl.savePath = item.getSavePath();
        dl.item = undefined;
        const ctx = { sessionId, receivedBytes: dl.receivedBytes, totalBytes: dl.totalBytes };
        if (state === 'completed') log.info('downloads', `Download completed: ${filename}`, ctx);
        else log.warn('downloads', `Download ${state}: ${filename}`, ctx);
        this.push(dl);
      });
    }
  }

  private push(dl: DownloadInfo) {
    this.win.webContents.send('download:update', {
      id: dl.id, filename: dl.filename, url: dl.url,
      state: dl.state, receivedBytes: dl.receivedBytes,
      totalBytes: dl.totalBytes, savePath: dl.savePath, sessionId: dl.sessionId,
    });
  }

  list() {
    return Array.from(this.downloads.values()).map(dl => ({
      id: dl.id, filename: dl.filename, url: dl.url,
      state: dl.state, receivedBytes: dl.receivedBytes,
      totalBytes: dl.totalBytes, savePath: dl.savePath, sessionId: dl.sessionId,
    }));
  }

  open(id: string)   { const dl = this.downloads.get(id); if (dl?.savePath) shell.openPath(dl.savePath); }
  reveal(id: string) { const dl = this.downloads.get(id); if (dl?.savePath) shell.showItemInFolder(dl.savePath); }
  cancel(id: string) { this.downloads.get(id)?.item?.cancel(); }

  clear() {
    for (const [id, dl] of this.downloads) if (dl.state !== 'progressing') this.downloads.delete(id);
    this.win.webContents.send('download:cleared');
  }
}
