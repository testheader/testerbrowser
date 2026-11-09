import type { WebContents } from 'electron';
import { WindowRegistry, WindowContext } from '../windowContext';

function fakeWindow() {
  const handlers = new Map<string, () => void>();
  let destroyed = false;
  let focused = false;
  const tabs = new Set<WebContents>();
  const wc = {} as WebContents;
  return {
    wc, tabs,
    destroy() { destroyed = true; handlers.get('closed')?.(); },
    focus() { focused = true; handlers.get('focus')?.(); },
    blur() { focused = false; },
    ctx: {
      win: {
        webContents: wc,
        isDestroyed: () => destroyed,
        isFocused: () => focused,
        on: (ev: string, fn: () => void) => { handlers.set(ev, fn); },
      },
      sessionManager: { ownsWebContents: (w: WebContents) => tabs.has(w) },
      visualRegressionStore: {},
    } as unknown as Omit<WindowContext, 'id'>,
  };
}

function makeRegistry() {
  const made: ReturnType<typeof fakeWindow>[] = [];
  const registry = new WindowRegistry(() => { const w = fakeWindow(); made.push(w); return w.ctx; });
  return { registry, made };
}

describe('WindowRegistry', () => {
  it('gives each window a distinct id and lists them', () => {
    const { registry } = makeRegistry();
    const a = registry.create();
    const b = registry.create();
    expect(a.id).not.toBe(b.id);
    expect(registry.all().map((c) => c.id)).toEqual([a.id, b.id]);
  });

  it('resolves a window from its chrome webContents or one of its tabs', () => {
    const { registry, made } = makeRegistry();
    const a = registry.create();
    const b = registry.create();
    const tab = {} as WebContents;
    made[1].tabs.add(tab);
    expect(registry.forWebContents(made[0].wc)).toBe(a);
    expect(registry.forWebContents(tab)).toBe(b);
    expect(registry.forWebContents({} as WebContents)).toBeNull();
  });

  it('drops a window once it is closed or destroyed', () => {
    const { registry, made } = makeRegistry();
    registry.create();
    const b = registry.create();
    made[0].destroy();
    expect(registry.all()).toEqual([b]);
    expect(registry.forWebContents(made[0].wc)).toBeNull();
    expect(registry.focused()).toBe(b);
    registry.remove(b.id);
    expect(registry.all()).toEqual([]);
    expect(registry.focused()).toBeNull();
  });

  it('focused() prefers the focused window, then the most recently focused', () => {
    const { registry, made } = makeRegistry();
    const a = registry.create();
    const b = registry.create();
    expect(registry.focused()).toBe(b); // newest, nothing focused yet
    made[0].focus();
    expect(registry.focused()).toBe(a);
    made[0].blur();
    expect(registry.focused()).toBe(a); // remembered after blur
  });
});
