import { BrowserWindow, shell } from 'electron';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';

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

export class DownloadManager {
  private win: BrowserWindow;
  private downloads = new Map<string, DownloadInfo>();

  constructor(win: BrowserWindow) {
    this.win = win;
  }

  private attached = new WeakSet<Electron.Session>();

  attach(ses: Electron.Session, sessionId: string) {
    // Several tabs can share one partition; hook will-download only once.
    if (this.attached.has(ses)) return;
    this.attached.add(ses);
    ses.on('will-download', (_event, item) => {
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
      this.push(dl);

      item.on('updated', (_e, state) => {
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
        this.push(dl);
      });
    });
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
