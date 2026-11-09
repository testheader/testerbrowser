import type { BrowserWindow, WebContents } from 'electron';
import type { SessionManager } from './sessionManager';
import type { VisualRegressionStore } from './visualRegressionStore';

/**
 * Everything that belongs to one TesterBrowser window (#367): the
 * BrowserWindow itself, the SessionManager that owns its tabs, and the
 * per-window visual-regression store. IPC handlers resolve their window from
 * the invoke event's sender through WindowRegistry.forWebContents().
 */
export interface WindowContext {
  id: number;
  win: BrowserWindow;
  sessionManager: SessionManager;
  visualRegressionStore: VisualRegressionStore;
}

export interface WindowCreateOptions {
  startUrl?: string;
  partition?: string;
  color?: string;
  /** webContents of the tab that called window.open(), when the window is a popup. */
  opener?: WebContents;
}

/** Builds the window, its SessionManager and store. Injected so the registry is testable without Electron. */
export type WindowFactory = (id: number, opts: WindowCreateOptions) => Omit<WindowContext, 'id'>;

export class WindowRegistry {
  private contexts = new Map<number, WindowContext>();
  private nextId = 1;
  private lastFocusedId: number | null = null;

  constructor(private factory: WindowFactory) {}

  create(opts: WindowCreateOptions = {}): WindowContext {
    const id = this.nextId++;
    const ctx: WindowContext = { id, ...this.factory(id, opts) };
    this.contexts.set(id, ctx);
    this.lastFocusedId = id;
    ctx.win.on('focus', () => { this.lastFocusedId = id; });
    ctx.win.on('closed', () => this.remove(id));
    return ctx;
  }

  /** Live windows only — a destroyed window is dropped as a side effect. */
  all(): WindowContext[] {
    for (const [id, ctx] of this.contexts) if (ctx.win.isDestroyed()) this.contexts.delete(id);
    return [...this.contexts.values()];
  }

  /**
   * The window a webContents belongs to: its chrome renderer, or one of its
   * tabs. Null if it belongs to none (e.g. a window already closed).
   */
  forWebContents(wc: WebContents): WindowContext | null {
    for (const ctx of this.all()) {
      if (ctx.win.webContents === wc || ctx.sessionManager.ownsWebContents(wc)) return ctx;
    }
    return null;
  }

  /** The focused window, else the most recently focused, else any. */
  focused(): WindowContext | null {
    const all = this.all();
    return all.find((c) => c.win.isFocused())
      ?? all.find((c) => c.id === this.lastFocusedId)
      ?? all[0]
      ?? null;
  }

  remove(id: number): void {
    this.contexts.delete(id);
    if (this.lastFocusedId === id) this.lastFocusedId = null;
  }
}
