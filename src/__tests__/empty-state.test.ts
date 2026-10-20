import { renderEmptyState } from '../../renderer/empty-state.js';

// The jest environment is plain node, so a tiny fake DOM stands in for the
// handful of APIs renderEmptyState uses.
class FakeEl {
  tag: string; className = ''; textContent = ''; type = '';
  attrs: Record<string, string> = {}; children: FakeEl[] = [];
  listeners: Record<string, Array<() => void>> = {};
  constructor(tag: string) { this.tag = tag; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  appendChild(c: FakeEl) { this.children.push(c); return c; }
  addEventListener(ev: string, fn: () => void) { (this.listeners[ev] ||= []).push(fn); }
}

beforeAll(() => {
  (globalThis as any).document = { createElement: (tag: string) => new FakeEl(tag) };
});
afterAll(() => { delete (globalThis as any).document; });

describe('renderEmptyState (#303)', () => {
  it('builds icon tile → title → one sentence, as a status region', () => {
    const el = renderEmptyState({ icon: 'circle-dot', tone: 'err', title: 'No recorded tests yet', text: 'Clicks become steps.' }) as unknown as FakeEl;
    expect(el.className).toBe('empty-state');
    expect(el.attrs.role).toBe('status');
    const [tile, title, text] = el.children;
    expect(tile.className).toBe('empty-state-icon tone-err');
    expect(tile.children[0].className).toBe('icon-circle-dot');
    expect(tile.children[0].attrs['aria-hidden']).toBe('true');
    expect(title.className).toBe('empty-state-title');
    expect(title.textContent).toBe('No recorded tests yet');
    expect(text.textContent).toBe('Clicks become steps.');
    expect(el.children).toHaveLength(3); // no button without an actionLabel
  });

  it('adds a labelled button that calls onAction', () => {
    const onAction = jest.fn();
    const el = renderEmptyState({ icon: 'search', title: 't', text: 'x', actionLabel: 'Start recording', onAction }) as unknown as FakeEl;
    const btn = el.children[3];
    expect(btn.tag).toBe('button');
    expect(btn.type).toBe('button');
    expect(btn.textContent).toBe('Start recording');
    btn.listeners.click[0]();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('defaults to the neutral tone', () => {
    const el = renderEmptyState({ icon: 'x', title: 't', text: 'x' }) as unknown as FakeEl;
    expect(el.children[0].className).toBe('empty-state-icon tone-neutral');
  });
});
