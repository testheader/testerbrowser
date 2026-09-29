import fs from 'fs';
import os from 'os';
import path from 'path';

let userDataDir: string;

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => (global as any).__tbUserDataDir) }, // eslint-disable-line @typescript-eslint/no-explicit-any
  BrowserWindow: class {},
  dialog: {
    showSaveDialog: jest.fn(),
    showOpenDialog: jest.fn(),
  },
}));

import { dialog } from 'electron';
import { VisualRegressionStore, validateBaselineSidecar, pngDimensions } from '../visualRegressionStore';

// A byte buffer that satisfies pngDimensions()'s own checks (signature +
// IHDR chunk type + width/height at their fixed offsets) without needing a
// real, fully-encoded PNG (IDAT/IEND, correct CRCs, ...) — nothing else in
// this module ever decodes the pixel data itself.
function makeFakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function fakeWin() {
  return {} as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-vrtest-'));
  (global as any).__tbUserDataDir = userDataDir; // eslint-disable-line @typescript-eslint/no-explicit-any
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('pngDimensions (#277)', () => {
  it('reads width/height from a well-formed PNG header', () => {
    expect(pngDimensions(makeFakePng(1280, 800))).toEqual({ width: 1280, height: 800 });
  });

  it('returns null for a buffer that is too short', () => {
    expect(pngDimensions(Buffer.alloc(10))).toBeNull();
  });

  it('returns null for a buffer with the wrong signature', () => {
    const buf = makeFakePng(100, 100);
    buf[0] = 0x00;
    expect(pngDimensions(buf)).toBeNull();
  });

  it('returns null when the first chunk is not IHDR', () => {
    const buf = makeFakePng(100, 100);
    buf.write('IDAT', 12, 'ascii');
    expect(pngDimensions(buf)).toBeNull();
  });

  it('returns null for zero width or height', () => {
    expect(pngDimensions(makeFakePng(0, 100))).toBeNull();
    expect(pngDimensions(makeFakePng(100, 0))).toBeNull();
  });
});

describe('validateBaselineSidecar (#277)', () => {
  function validSidecar(overrides: Record<string, unknown> = {}) {
    return { name: 'homepage', url: 'https://example.com/', width: 1280, height: 800, ignoreRegions: [], ...overrides };
  }

  it('accepts a fully valid sidecar', () => {
    const result = validateBaselineSidecar(validSidecar({ ignoreRegions: [{ x: 1, y: 2, w: 3, h: 4 }] }));
    expect(result.error).toBeUndefined();
    expect(result.meta).toMatchObject({ name: 'homepage', url: 'https://example.com/', width: 1280, height: 800 });
    expect(result.meta?.ignoreRegions).toEqual([{ x: 1, y: 2, w: 3, h: 4 }]);
  });

  it('accepts a sidecar with ignoreRegions omitted, defaulting to an empty array', () => {
    const { ignoreRegions: _ignoreRegions, ...withoutRegions } = validSidecar();
    const result = validateBaselineSidecar(withoutRegions);
    expect(result.error).toBeUndefined();
    expect(result.meta?.ignoreRegions).toEqual([]);
  });

  it('rejects null and primitives', () => {
    expect(validateBaselineSidecar(null).error).toBeTruthy();
    expect(validateBaselineSidecar('nope').error).toBeTruthy();
    expect(validateBaselineSidecar(42).error).toBeTruthy();
  });

  it('rejects a missing/empty name', () => {
    expect(validateBaselineSidecar(validSidecar({ name: '' })).error).toContain('name');
    expect(validateBaselineSidecar(validSidecar({ name: undefined })).error).toContain('name');
  });

  it('rejects a non-string url', () => {
    expect(validateBaselineSidecar(validSidecar({ url: 42 })).error).toContain('url');
  });

  it('rejects malformed dimensions', () => {
    expect(validateBaselineSidecar(validSidecar({ width: 0 })).error).toContain('width');
    expect(validateBaselineSidecar(validSidecar({ width: -5 })).error).toContain('width');
    expect(validateBaselineSidecar(validSidecar({ width: 12.5 })).error).toContain('width');
    expect(validateBaselineSidecar(validSidecar({ height: 'tall' })).error).toContain('height');
  });

  it('rejects ignoreRegions that is not an array', () => {
    expect(validateBaselineSidecar(validSidecar({ ignoreRegions: 'nope' })).error).toContain('ignoreRegions');
  });

  it('rejects an ignoreRegions entry missing a numeric field', () => {
    const result = validateBaselineSidecar(validSidecar({ ignoreRegions: [{ x: 1, y: 2, w: 3 }] }));
    expect(result.error).toContain('ignoreRegions');
  });
});

describe('VisualRegressionStore (#277)', () => {
  it('save() derives width/height from the PNG itself and list()/get() return it back', () => {
    const store = new VisualRegressionStore(fakeWin());
    const meta = store.save('Homepage', 'https://example.com/', makeFakePng(640, 480).toString('base64'));
    expect(meta).not.toBeNull();
    expect(meta!.width).toBe(640);
    expect(meta!.height).toBe(480);
    expect(meta!.ignoreRegions).toEqual([]);

    expect(store.list()).toHaveLength(1);
    const fetched = store.get(meta!.id);
    expect(fetched?.meta).toEqual(meta);
    expect(Buffer.from(fetched!.b64, 'base64')).toEqual(makeFakePng(640, 480));
  });

  it('save() returns null and persists nothing for an invalid PNG', () => {
    const store = new VisualRegressionStore(fakeWin());
    const meta = store.save('bad', 'https://example.com/', Buffer.from('not a png').toString('base64'));
    expect(meta).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('setIgnoreRegions persists regions, readable back via get()', () => {
    const store = new VisualRegressionStore(fakeWin());
    const meta = store.save('Homepage', 'https://example.com/', makeFakePng(100, 100).toString('base64'));
    const ok = store.setIgnoreRegions(meta!.id, [{ x: 1, y: 1, w: 10, h: 10 }]);
    expect(ok).toBe(true);
    expect(store.get(meta!.id)?.meta.ignoreRegions).toEqual([{ x: 1, y: 1, w: 10, h: 10 }]);
  });

  it('setIgnoreRegions returns false for an id that does not exist', () => {
    const store = new VisualRegressionStore(fakeWin());
    expect(store.setIgnoreRegions('no-such-id', [])).toBe(false);
  });

  it('delete() removes both files, and it stops appearing in list()', () => {
    const store = new VisualRegressionStore(fakeWin());
    const meta = store.save('Homepage', 'https://example.com/', makeFakePng(100, 100).toString('base64'));
    expect(store.delete(meta!.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.get(meta!.id)).toBeNull();
  });

  it('list() skips an orphaned sidecar with no matching PNG', () => {
    const store = new VisualRegressionStore(fakeWin());
    const meta = store.save('Homepage', 'https://example.com/', makeFakePng(100, 100).toString('base64'));
    fs.unlinkSync(path.join(userDataDir, 'baselines', `${meta!.id}.png`));
    expect(store.list()).toEqual([]);
  });

  it('exportBaseline writes the PNG plus a same-basename sidecar JSON without the internal id', async () => {
    const store = new VisualRegressionStore(fakeWin());
    const meta = store.save('Homepage', 'https://example.com/', makeFakePng(200, 150).toString('base64'));
    const exportPath = path.join(userDataDir, 'exported', 'my-baseline.png');
    fs.mkdirSync(path.dirname(exportPath), { recursive: true });
    (dialog.showSaveDialog as jest.Mock).mockResolvedValue({ canceled: false, filePath: exportPath });

    const result = await store.exportBaseline(meta!.id);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(exportPath)).toBe(true);
    const sidecarPath = exportPath.replace(/\.png$/, '') + '.json';
    expect(fs.existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    expect(sidecar).not.toHaveProperty('id');
    expect(sidecar.name).toBe('Homepage');
    expect(sidecar.width).toBe(200);
  });

  it('exportBaseline reports canceled without writing anything when the dialog is dismissed', async () => {
    const store = new VisualRegressionStore(fakeWin());
    const meta = store.save('Homepage', 'https://example.com/', makeFakePng(200, 150).toString('base64'));
    (dialog.showSaveDialog as jest.Mock).mockResolvedValue({ canceled: true });
    const result = await store.exportBaseline(meta!.id);
    expect(result.canceled).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('importBaseline round-trips an exported baseline into a fresh entry with a new id', async () => {
    const store = new VisualRegressionStore(fakeWin());
    const original = store.save('Homepage', 'https://example.com/', makeFakePng(320, 240).toString('base64'));
    store.setIgnoreRegions(original!.id, [{ x: 5, y: 5, w: 20, h: 20 }]);

    const exportPath = path.join(userDataDir, 'exported', 'homepage.png');
    fs.mkdirSync(path.dirname(exportPath), { recursive: true });
    (dialog.showSaveDialog as jest.Mock).mockResolvedValue({ canceled: false, filePath: exportPath });
    await store.exportBaseline(original!.id);

    (dialog.showOpenDialog as jest.Mock).mockResolvedValue({ canceled: false, filePaths: [exportPath] });
    const result = await store.importBaseline();
    expect(result.ok).toBe(true);
    expect(result.imported!.id).not.toBe(original!.id);
    expect(result.imported!.name).toBe('Homepage');
    expect(result.imported!.width).toBe(320);
    expect(result.imported!.ignoreRegions).toEqual([{ x: 5, y: 5, w: 20, h: 20 }]);

    expect(store.list()).toHaveLength(2); // the original plus the imported copy
  });

  it('importBaseline rejects a PNG with no matching sidecar file', async () => {
    const store = new VisualRegressionStore(fakeWin());
    const lonePngPath = path.join(userDataDir, 'lone.png');
    fs.writeFileSync(lonePngPath, makeFakePng(100, 100));
    (dialog.showOpenDialog as jest.Mock).mockResolvedValue({ canceled: false, filePaths: [lonePngPath] });

    const result = await store.importBaseline();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('sidecar');
    expect(store.list()).toEqual([]);
  });

  it('importBaseline rejects a sidecar that fails validation', async () => {
    const store = new VisualRegressionStore(fakeWin());
    const pngPath = path.join(userDataDir, 'bad.png');
    fs.writeFileSync(pngPath, makeFakePng(100, 100));
    fs.writeFileSync(path.join(userDataDir, 'bad.json'), JSON.stringify({ name: '', url: '', width: 0, height: 0 }));
    (dialog.showOpenDialog as jest.Mock).mockResolvedValue({ canceled: false, filePaths: [pngPath] });

    const result = await store.importBaseline();
    expect(result.ok).toBe(false);
    expect(store.list()).toEqual([]);
  });
});
