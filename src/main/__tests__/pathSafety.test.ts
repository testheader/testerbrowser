import os from 'os';
import path from 'path';
import fs from 'fs';
import { isSafeId, isPathInside } from '../pathSafety';
import { VisualRegressionStore } from '../visualRegressionStore';

describe('isSafeId (L5)', () => {
  it.each(['1727700000000-abc123', 'home-page-m1abcd-x9z1', 'a', 'A_b-9'])('accepts %p', (id) => {
    expect(isSafeId(id)).toBe(true);
  });

  it.each(['', '../x', '..', 'a/b', 'a\\b', 'C:x', 'a.b', 'a b', 'x'.repeat(129), undefined, 42, null])('rejects %p', (id) => {
    expect(isSafeId(id)).toBe(false);
  });
});

describe('isPathInside (L5)', () => {
  const dir = path.join(os.tmpdir(), 'tb-shots');

  it('accepts a file directly inside the directory', () => {
    expect(isPathInside(path.join(dir, 'issue-1.jpg'), dir)).toBe(true);
  });

  it('rejects .. traversal that the old startsWith prefix check let through', () => {
    const escaped = `${dir}${path.sep}..${path.sep}secret.txt`;
    expect(escaped.startsWith(dir)).toBe(true);
    expect(isPathInside(escaped, dir)).toBe(false);
  });

  it('rejects a sibling directory that merely shares the prefix', () => {
    expect(isPathInside(`${dir}-evil${path.sep}x.jpg`, dir)).toBe(false);
  });

  it('rejects the directory itself, empty and non-string input', () => {
    expect(isPathInside(dir, dir)).toBe(false);
    expect(isPathInside('', dir)).toBe(false);
    expect(isPathInside(undefined, dir)).toBe(false);
  });
});

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => (global as any).__tbUserDataDir) }, // eslint-disable-line @typescript-eslint/no-explicit-any
  dialog: {},
  BrowserWindow: class {},
}));

describe('VisualRegressionStore id validation (L5)', () => {
  let userDataDir: string;
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-vr-ids-'));
    (global as any).__tbUserDataDir = userDataDir; // eslint-disable-line @typescript-eslint/no-explicit-any
  });
  afterEach(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

  it('refuses a traversal id for get/setIgnoreRegions/delete without touching files outside baselines/', () => {
    const outside = path.join(userDataDir, 'victim.json');
    fs.writeFileSync(outside, JSON.stringify({ id: 'victim', ignoreRegions: [] }));
    const store = new VisualRegressionStore({} as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(store.get('../victim')).toBeNull();
    expect(store.setIgnoreRegions('../victim', [{ x: 0, y: 0, w: 1, h: 1 }])).toBe(false);
    expect(store.delete('../victim')).toBe(false);
    expect(JSON.parse(fs.readFileSync(outside, 'utf-8'))).toEqual({ id: 'victim', ignoreRegions: [] });
  });
});
