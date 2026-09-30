import { pushMru, nextMruId } from '../../renderer/tabs.js';

describe('pushMru (#279)', () => {
  it('visiting a tab moves it to the front of an empty stack', () => {
    expect(pushMru([], 'a')).toEqual(['a']);
  });

  it('visiting a new tab moves it to the front, keeping the rest in order', () => {
    expect(pushMru(['a', 'b', 'c'], 'd')).toEqual(['d', 'a', 'b', 'c']);
  });

  it('re-visiting a tab already in the stack moves it to the front without duplicating it', () => {
    expect(pushMru(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
  });

  it('re-visiting the already-front tab is a no-op in effect', () => {
    expect(pushMru(['a', 'b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const stack = ['a', 'b', 'c'];
    pushMru(stack, 'b');
    expect(stack).toEqual(['a', 'b', 'c']);
  });
});

describe('nextMruId (#279)', () => {
  it('returns null when there are fewer than two tabs', () => {
    expect(nextMruId([], false)).toBeNull();
    expect(nextMruId(['a'], false)).toBeNull();
    expect(nextMruId([], true)).toBeNull();
    expect(nextMruId(['a'], true)).toBeNull();
  });

  it('forward (Ctrl+Tab) selects the second-most-recently-used tab', () => {
    expect(nextMruId(['a', 'b', 'c', 'd'], false)).toBe('b');
  });

  it('reverse (Ctrl+Shift+Tab) selects the least-recently-used tab, wrapping to the far end', () => {
    expect(nextMruId(['a', 'b', 'c', 'd'], true)).toBe('d');
  });

  it('with exactly two tabs, forward and reverse both select the other one', () => {
    expect(nextMruId(['a', 'b'], false)).toBe('b');
    expect(nextMruId(['a', 'b'], true)).toBe('b');
  });

  // Each real switch (cycleTab) also calls recordVisit/pushMru on the chosen
  // id, moving it to the front. Forward always jumps to position 1, so two
  // repeated forward presses land back where they started — this is real,
  // intentional Alt-Tab-style behavior (toggle between your two most recent
  // tabs), not a bug, and worth locking down precisely rather than assumed.
  it('repeated forward cycling (each hop re-recorded via pushMru) oscillates between the two most recent tabs', () => {
    let stack = ['a', 'b', 'c', 'd'];
    const visited = [stack[0]];
    for (let i = 0; i < 4; i++) {
      const next = nextMruId(stack, false)!;
      visited.push(next);
      stack = pushMru(stack, next);
    }
    expect(visited).toEqual(['a', 'b', 'a', 'b', 'a']);
  });

  // A tab visited some other way in between (a direct click, not cycling)
  // is what actually lets forward cycling reach further into the stack —
  // recordVisit re-fronts whichever tab that was, so the *next* forward
  // cycle's target (position 1) becomes the tab displaced by that visit.
  it('an interleaved direct visit changes which tab the next forward cycle reaches', () => {
    let stack = ['a', 'b', 'c', 'd'];
    stack = pushMru(stack, nextMruId(stack, false)!); // Ctrl+Tab: a,b,c,d -> b,a,c,d
    stack = pushMru(stack, 'c');                       // direct click on 'c' -> c,b,a,d
    expect(nextMruId(stack, false)).toBe('b');
  });

  it('cycling skips a tab that has already been removed from the stack, without erroring', () => {
    // 'c' was closed elsewhere (its own removal — mruStack.filter(x => x !== id)
    // — is not this function's job); the stack here reflects the aftermath.
    const stack = ['a', 'b', 'd']; // 'c' already gone
    expect(() => nextMruId(stack, false)).not.toThrow();
    expect(nextMruId(stack, false)).toBe('b');
    expect(nextMruId(stack, true)).toBe('d');
  });
});
