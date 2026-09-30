import { moveInArray } from '../mockManager';

describe('moveInArray (#263 — Mock rule reordering)', () => {
  it('swaps an element with its predecessor when moved up', () => {
    expect(moveInArray(['a', 'b', 'c'], 1, 'up')).toEqual(['b', 'a', 'c']);
  });

  it('swaps an element with its successor when moved down', () => {
    expect(moveInArray(['a', 'b', 'c'], 1, 'down')).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op moving the first element up', () => {
    expect(moveInArray(['a', 'b', 'c'], 0, 'up')).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op moving the last element down', () => {
    expect(moveInArray(['a', 'b', 'c'], 2, 'down')).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op for an out-of-range index', () => {
    expect(moveInArray(['a', 'b', 'c'], 5, 'up')).toEqual(['a', 'b', 'c']);
    expect(moveInArray(['a', 'b', 'c'], -1, 'down')).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op on a single-element array', () => {
    expect(moveInArray(['a'], 0, 'up')).toEqual(['a']);
    expect(moveInArray(['a'], 0, 'down')).toEqual(['a']);
  });

  it('does not mutate the original array', () => {
    const original = ['a', 'b', 'c'];
    const moved = moveInArray(original, 0, 'down');

    expect(original).toEqual(['a', 'b', 'c']);
    expect(moved).not.toBe(original);
  });

  it('moves an object element by reference, not a clone', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const [first, second] = moveInArray([a, b], 0, 'down');

    expect(first).toBe(b);
    expect(second).toBe(a);
  });
});
