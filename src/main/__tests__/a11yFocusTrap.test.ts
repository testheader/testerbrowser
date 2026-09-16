import { classifyFocusTrapSequence } from '../sessionManager';

describe('classifyFocusTrapSequence (#198 — focus trap detector)', () => {
  it('passes when the walk reaches the expected terminal element', () => {
    const result = classifyFocusTrapSequence(['a', 'b', 'c'], 'c');
    expect(result).toMatchObject({ passed: true, kind: 'pass', trappedElements: [] });
  });

  it('still passes if the sequence continues (wraps around) after reaching the terminal', () => {
    // Normal browser behaviour: Tab from the last element wraps back toward
    // the first, which is not itself a trap.
    const result = classifyFocusTrapSequence(['a', 'b', 'c', 'a', 'b'], 'c');
    expect(result).toMatchObject({ passed: true, kind: 'pass' });
  });

  it('reports a cycle when focus repeats a sub-sequence before ever reaching the terminal', () => {
    const result = classifyFocusTrapSequence(['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b'], 'z');
    expect(result.passed).toBe(false);
    expect(result.kind).toBe('cycle');
    expect(new Set(result.trappedElements)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('reports a dead end when the same single element repeats without reaching the terminal', () => {
    const result = classifyFocusTrapSequence(['a', 'b', 'b'], 'z');
    expect(result.passed).toBe(false);
    expect(result.kind).toBe('dead-end');
    expect(result.trappedElements).toEqual(['b']);
  });

  it('reports incomplete when the budget runs out with no repeat and no terminal reached', () => {
    const result = classifyFocusTrapSequence(['a', 'b', 'c'], 'z');
    expect(result.passed).toBe(false);
    expect(result.kind).toBe('incomplete');
  });

  it('reports incomplete for an empty sequence', () => {
    const result = classifyFocusTrapSequence([], 'z');
    expect(result.passed).toBe(false);
    expect(result.kind).toBe('incomplete');
  });
});
