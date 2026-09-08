import { upsertById } from '../upsert';

describe('upsertById (#162 — tests:save must edit in place, not duplicate)', () => {
  it('replaces the existing item with a matching id instead of appending', () => {
    const original = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    const edited = { id: 'a', name: 'A-edited' };

    const result = upsertById(original, edited);

    expect(result).toHaveLength(2);
    expect(result.find(t => t.id === 'a')).toEqual({ id: 'a', name: 'A-edited' });
    expect(result.find(t => t.id === 'b')).toEqual({ id: 'b', name: 'B' });
  });

  it('appends when no item with that id exists', () => {
    const original = [{ id: 'a', name: 'A' }];
    const added = { id: 'c', name: 'C' };

    const result = upsertById(original, added);

    expect(result).toHaveLength(2);
    expect(result.map(t => t.id)).toEqual(['a', 'c']);
  });

  it('preserves the position of the edited item rather than moving it to the end', () => {
    const original = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
    const edited = { id: 'b', name: 'B-edited' };

    const result = upsertById(original, edited);

    expect(result.map(t => t.name)).toEqual(['A', 'B-edited', 'C']);
  });

  it('does not mutate the original array', () => {
    const original = [{ id: 'a', name: 'A' }];
    upsertById(original, { id: 'a', name: 'A-edited' });
    expect(original[0].name).toBe('A');
  });
});
