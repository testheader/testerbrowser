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
    dm.attach(ses); dm.attach(ses); dm.attach(ses);
    ses.emit('will-download', {}, fakeItem('a.txt'));
    expect(dm.list()).toHaveLength(1);
  });

  it('renames with (n) when the file exists', () => {
    jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => /a\.txt$|a \(1\)\.txt$/.test(String(p)));
    const dm = new DownloadManager(win);
    const ses: any = new EventEmitter();
    dm.attach(ses);
    ses.emit('will-download', {}, fakeItem('a.txt'));
    expect(dm.list()[0].filename).toBe('a (2).txt');
  });

  it('strips directory traversal from filenames', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const dm = new DownloadManager(win);
    const ses: any = new EventEmitter();
    dm.attach(ses);
    const item = fakeItem('../../evil.txt');
    ses.emit('will-download', {}, item);
    expect(dm.list()[0].filename).toBe('evil.txt');
    expect(item.setSavePath.mock.calls[0][0]).toMatch(/[\\/]dl[\\/]evil\.txt$/);
  });
});
