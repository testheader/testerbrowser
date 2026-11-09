import { buildSessionsFile, parseSessionsFile, WindowSaveState } from '../sessionPersistence';

const tab = (id: string, partition = `persist:${id}`) => ({ id, name: id, partition, url: `https://${id}.test/`, color: '#fff', pinned: false });
const state = (over: Partial<WindowSaveState> = {}): WindowSaveState => ({ sessions: [], notes: {}, emulation: {}, mocks: {}, ...over });

describe('open-sessions.json (#367)', () => {
  it('writes one entry per window, keeping tab order', () => {
    const file = buildSessionsFile([
      state({ sessions: [tab('a'), tab('b')] }),
      state({ sessions: [tab('c')] }),
    ]);
    expect(file.windows.map((w) => w.sessions.map((s) => s.id))).toEqual([['a', 'b'], ['c']]);
  });

  it('leaves out windows with no persistent tabs', () => {
    const file = buildSessionsFile([state({ sessions: [tab('a')] }), state(), state({ sessions: [tab('c')] })]);
    expect(file.windows).toHaveLength(2);
  });

  it('merges notes, emulation and mocks from every window into the shared top level', () => {
    const file = buildSessionsFile([
      state({ sessions: [tab('a')], notes: { a: 'note a' }, emulation: { 'persist:a': { userAgent: 'UA' } as never } }),
      state({ sessions: [tab('b')], notes: { b: 'note b' }, mocks: { 'persist:b': [{ id: 'm' } as never] } }),
    ]);
    expect(file.notes).toEqual({ a: 'note a', b: 'note b' });
    expect(Object.keys(file.emulation)).toEqual(['persist:a']);
    expect(Object.keys(file.mocks)).toEqual(['persist:b']);
  });

  it('also writes a flat sessions array so an older build still restores every tab', () => {
    const file = buildSessionsFile([state({ sessions: [tab('a')] }), state({ sessions: [tab('b')] })]);
    expect(file.sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('round-trips through JSON', () => {
    const states = [
      state({ sessions: [tab('a')], notes: { a: 'n' } }),
      state({ sessions: [tab('b'), tab('c')] }),
    ];
    const parsed = parseSessionsFile(JSON.parse(JSON.stringify(buildSessionsFile(states))));
    expect(parsed.windows.map((w) => w.sessions.map((s) => s.id))).toEqual([['a'], ['b', 'c']]);
    expect(parsed.notes).toEqual({ a: 'n' });
  });

  it('reads a file written before multi-window as a single window with nothing lost', () => {
    const legacy = {
      sessions: [tab('a'), tab('b')],
      notes: { a: 'old note' },
      emulation: { 'persist:a': { locale: 'nl-NL' } },
      mocks: { 'persist:b': [{ id: 'm1' }] },
    };
    const parsed = parseSessionsFile(legacy);
    expect(parsed.windows).toHaveLength(1);
    expect(parsed.windows[0].sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(parsed.notes).toEqual({ a: 'old note' });
    expect(parsed.emulation['persist:a']).toEqual({ locale: 'nl-NL' });
    expect(parsed.mocks['persist:b']).toHaveLength(1);
  });

  it('reads an unreadable or empty file as no windows', () => {
    for (const bad of [null, undefined, 'x', 3, [], {}, { sessions: [] }, { windows: 'nope' }, { windows: [{ sessions: [] }] }]) {
      expect(parseSessionsFile(bad).windows).toEqual([]);
    }
  });
});
