import { EventEmitter } from 'events';
import fs from 'fs';

jest.mock('electron', () => ({
  BrowserWindow: class {},
  shell: {},
  app: { getPath: () => '/dl' },
}));

import { DownloadManager } from '../downloadManager';

function fakeItem(name: string) {
  const item: any = new EventEmitter();
  item.getFilename = () => name;
  item.getURL = () => 'http://x/' + name;
  item.getTotalBytes = () => 10;
  item.setSavePath = jest.fn();
  return item;
}

describe('DownloadManager', () => {
  const send = jest.fn();
  const win: any = { webContents: { send } };
  afterEach(() => jest.restoreAllMocks());

  it('attach twice on one session yields one entry per download', () => {
    const dm = new DownloadManager(win);
    const ses: any = new EventEmitter();
    dm.attach(ses, 'session-1'); dm.attach(ses, 'session-1'); dm.attach(ses, 'session-1');
    ses.emit('will-download', {}, fakeItem('a.txt'));
    expect(dm.list()).toHaveLength(1);
  });

  it('renames with (n) when the file exists', () => {
    jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => /a\.txt$|a \(1\)\.txt$/.test(String(p)));
    const dm = new DownloadManager(win);
    const ses: any = new EventEmitter();
    dm.attach(ses, 'session-1');
    ses.emit('will-download', {}, fakeItem('a.txt'));
    expect(dm.list()[0].filename).toBe('a (2).txt');
  });

  it('strips directory traversal from filenames', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const dm = new DownloadManager(win);
    const ses: any = new EventEmitter();
    dm.attach(ses, 'session-1');
    const item = fakeItem('../../evil.txt');
    ses.emit('will-download', {}, item);
    expect(dm.list()[0].filename).toBe('evil.txt');
    expect(item.setSavePath.mock.calls[0][0]).toMatch(/[\\/]dl[\\/]evil\.txt$/);
  });

  // #247: DownloadInfo carries which tab's session triggered it, so the
  // downloads panel can show the originating tab's name/color.
  it('attach(ses, sessionId) stamps every DownloadInfo from that session with sessionId', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const dm = new DownloadManager(win);
    const ses: any = new EventEmitter();
    dm.attach(ses, 'session-1');
    ses.emit('will-download', {}, fakeItem('a.txt'));
    expect(dm.list()[0].sessionId).toBe('session-1');
  });

  it('sends sessionId through the download:update push and the download:list result alike', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    send.mockClear();
    const dm = new DownloadManager(win);
    const ses: any = new EventEmitter();
    dm.attach(ses, 'session-42');
    ses.emit('will-download', {}, fakeItem('a.txt'));

    const pushed = send.mock.calls.find((c: any[]) => c[0] === 'download:update')?.[1];
    expect(pushed.sessionId).toBe('session-42');
    expect(dm.list()[0].sessionId).toBe('session-42');
  });

  it('a second, differently-attached-id call on an already-attached session keeps the original sessionId (per-partition, not per-tab, attribution)', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const dm = new DownloadManager(win);
    const ses: any = new EventEmitter();
    dm.attach(ses, 'first-tab');
    dm.attach(ses, 'second-tab'); // same partition, later tab — a no-op per the WeakSet guard
    ses.emit('will-download', {}, fakeItem('a.txt'));
    expect(dm.list()[0].sessionId).toBe('first-tab');
  });
});
