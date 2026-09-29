import fs from 'fs';
import path from 'path';
import { app, dialog, BrowserWindow } from 'electron';
import { log } from './appLogger';

export interface IgnoreRegion { x: number; y: number; w: number; h: number; }

export interface BaselineMeta {
  id: string;
  name: string;
  url: string;
  capturedAt: number;
  width: number;
  height: number;
  ignoreRegions: IgnoreRegion[];
}

// A PNG's width/height live at a fixed offset in its first chunk (IHDR),
// right after the 8-byte signature — reading them here means the sidecar's
// dimensions can never drift from what's actually in the PNG file (no
// separate width/height ever has to be threaded through from the renderer
// and kept in sync), and callers get useful width/height back even for a
// freshly-imported baseline whose sidecar might have been hand-edited or
// come from a different tool. Returns null for anything that isn't a valid
// PNG with an IHDR chunk (bad/truncated file).
export function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function slugify(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (base || 'baseline').slice(0, 60);
}

export type ValidatedBaselineSidecar = Omit<BaselineMeta, 'id' | 'capturedAt'> & { capturedAt?: number };

// #277: pure so every branch is unit-testable without the main process or
// dialogs around it — mirrors validateImportedMockRules (#264)/
// validateImportedTests (#274) in shape. `json` is whatever JSON.parse()
// produced from a sidecar file the user picked — entirely untrusted.
// Whether the PNG the sidecar claims to describe actually exists alongside
// it is a filesystem check the caller (importBaseline) makes separately,
// not something this function has any way to know.
export function validateBaselineSidecar(json: unknown): { meta?: ValidatedBaselineSidecar; error?: string } {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { error: 'Not a valid baseline sidecar file' };
  }
  const j = json as Record<string, unknown>;
  if (typeof j.name !== 'string' || j.name.trim().length === 0) return { error: 'name must be a non-empty string' };
  if (typeof j.url !== 'string') return { error: 'url must be a string' };
  if (!Number.isInteger(j.width) || (j.width as number) <= 0) return { error: 'width must be a positive integer' };
  if (!Number.isInteger(j.height) || (j.height as number) <= 0) return { error: 'height must be a positive integer' };

  const ignoreRegions: IgnoreRegion[] = [];
  if (j.ignoreRegions !== undefined) {
    if (!Array.isArray(j.ignoreRegions)) return { error: 'ignoreRegions must be an array' };
    for (const raw of j.ignoreRegions) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'ignoreRegions entries must be objects' };
      const r = raw as Record<string, unknown>;
      if (!(['x', 'y', 'w', 'h'] as const).every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))) {
        return { error: 'ignoreRegions entries must have numeric x/y/w/h' };
      }
      ignoreRegions.push({ x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number });
    }
  }

  return {
    meta: {
      name: j.name,
      url: j.url,
      width: j.width as number,
      height: j.height as number,
      ignoreRegions,
      capturedAt: typeof j.capturedAt === 'number' ? j.capturedAt : undefined,
    },
  };
}

// #277: saved baselines for UI diff — each one is a PNG plus a same-
// basename sidecar JSON (name/URL/capture date/dimensions/ignore regions)
// under userData/baselines/. Global, not per-session (unlike the rest of
// visual regression's in-memory sessionData in visual-regression.js) —
// the whole point is a baseline surviving past the tab, and even the app
// restart, that captured it.
export class VisualRegressionStore {
  private win: BrowserWindow;
  private dir: string;

  constructor(win: BrowserWindow) {
    this.win = win;
    this.dir = path.join(app.getPath('userData'), 'baselines');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) {
      log.warn('vr', 'Failed to create baselines directory', { error: String(e) });
    }
  }

  private metaPath(id: string): string { return path.join(this.dir, `${id}.json`); }
  private pngPath(id: string): string { return path.join(this.dir, `${id}.png`); }

  private readMeta(id: string): BaselineMeta | null {
    try { return JSON.parse(fs.readFileSync(this.metaPath(id), 'utf-8')) as BaselineMeta; } catch { return null; }
  }

  list(): BaselineMeta[] {
    let files: string[] = [];
    try { files = fs.readdirSync(this.dir); } catch { return []; }
    const metas: BaselineMeta[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -'.json'.length);
      if (!fs.existsSync(this.pngPath(id))) continue; // an orphaned sidecar with no image is not a usable baseline
      const meta = this.readMeta(id);
      if (meta) metas.push(meta);
    }
    return metas.sort((a, b) => b.capturedAt - a.capturedAt);
  }

  get(id: string): { meta: BaselineMeta; b64: string } | null {
    const meta = this.readMeta(id);
    if (!meta) return null;
    try {
      const b64 = fs.readFileSync(this.pngPath(id)).toString('base64');
      return { meta, b64 };
    } catch {
      return null;
    }
  }

  save(name: string, url: string, b64: string): BaselineMeta | null {
    const buf = Buffer.from(b64, 'base64');
    const dims = pngDimensions(buf);
    if (!dims) return null;
    const id = `${slugify(name)}-${Date.now().toString(36)}`;
    const meta: BaselineMeta = { id, name, url, capturedAt: Date.now(), width: dims.width, height: dims.height, ignoreRegions: [] };
    try {
      fs.writeFileSync(this.pngPath(id), buf);
      fs.writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2));
    } catch (e) {
      log.warn('vr', 'Failed to save baseline', { error: String(e) });
      return null;
    }
    return meta;
  }

  setIgnoreRegions(id: string, ignoreRegions: IgnoreRegion[]): boolean {
    const meta = this.readMeta(id);
    if (!meta) return false;
    meta.ignoreRegions = ignoreRegions;
    try {
      fs.writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2));
      return true;
    } catch (e) {
      log.warn('vr', 'Failed to save ignore regions', { error: String(e) });
      return false;
    }
  }

  delete(id: string): boolean {
    let deleted = false;
    try { fs.unlinkSync(this.pngPath(id)); deleted = true; } catch {}
    try { fs.unlinkSync(this.metaPath(id)); deleted = true; } catch {}
    return deleted;
  }

  // Two plain file saves (the PNG, and a same-basename sidecar JSON) rather
  // than a zip — no zip library already exists anywhere in this repo, and
  // adding one for a single feature isn't worth it. One save dialog picks
  // the PNG's path; the sidecar is written right next to it, same basename.
  async exportBaseline(id: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
    const entry = this.get(id);
    if (!entry) return { ok: false, error: 'Baseline not found' };
    const result = await dialog.showSaveDialog(this.win, {
      title: 'Export baseline',
      defaultPath: `${slugify(entry.meta.name)}.png`,
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      const pngPath = result.filePath;
      const sidecarPath = pngPath.replace(/\.png$/i, '') + '.json';
      fs.writeFileSync(pngPath, Buffer.from(entry.b64, 'base64'));
      const { id: _id, ...sidecar } = entry.meta;
      fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
      log.info('vr', 'Baseline exported', { id });
      return { ok: true, path: pngPath };
    } catch (e) {
      log.warn('vr', 'Baseline export failed', { id, error: String(e) });
      return { ok: false, error: String(e) };
    }
  }

  // #277: looks for a same-basename sidecar JSON next to the chosen PNG
  // (exportBaseline's own layout) — a PNG with no sidecar is rejected
  // outright rather than imported with guessed/empty metadata, since a
  // baseline with no known source URL or dimensions is of little use.
  async importBaseline(): Promise<{ ok: boolean; imported?: BaselineMeta; canceled?: boolean; error?: string }> {
    const result = await dialog.showOpenDialog(this.win, {
      title: 'Import baseline',
      filters: [{ name: 'PNG image', extensions: ['png'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const pngPath = result.filePaths[0];
    const sidecarPath = pngPath.replace(/\.png$/i, '') + '.json';

    let pngBuf: Buffer;
    try {
      pngBuf = fs.readFileSync(pngPath);
    } catch {
      return { ok: false, error: 'Could not read the selected PNG file' };
    }
    if (!pngDimensions(pngBuf)) return { ok: false, error: 'Not a valid PNG file' };

    if (!fs.existsSync(sidecarPath)) {
      return { ok: false, error: `No matching sidecar file found (expected ${path.basename(sidecarPath)} next to the PNG)` };
    }
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    } catch {
      return { ok: false, error: 'Sidecar file is not valid JSON' };
    }
    const { meta, error } = validateBaselineSidecar(json);
    if (error || !meta) return { ok: false, error: error || 'Invalid sidecar file' };

    const id = `${slugify(meta.name)}-${Date.now().toString(36)}`;
    const fullMeta: BaselineMeta = { id, ...meta, capturedAt: meta.capturedAt ?? Date.now() };
    try {
      fs.writeFileSync(this.pngPath(id), pngBuf);
      fs.writeFileSync(this.metaPath(id), JSON.stringify(fullMeta, null, 2));
    } catch (e) {
      log.warn('vr', 'Baseline import failed', { error: String(e) });
      return { ok: false, error: String(e) };
    }
    log.info('vr', 'Baseline imported', { id });
    return { ok: true, imported: fullMeta };
  }
}
