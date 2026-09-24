import { mergeRecordedSteps } from '../../renderer/utils.js';

describe('mergeRecordedSteps (#224)', () => {
  it('appends only the remote steps past receivedCount', () => {
    const local = [{ id: 'a' }, { id: 'b' }];
    const remote = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const result = mergeRecordedSteps(local, remote, 2);
    expect(result).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  });

  it('preserves a locally deleted step instead of re-adding it from the remote list', () => {
    // Tester deleted 'b' locally; the remote buffer still has it (and
    // nothing new yet) — it must not come back.
    const local = [{ id: 'a' }];
    const remote = [{ id: 'a' }, { id: 'b' }];
    const result = mergeRecordedSteps(local, remote, 2);
    expect(result).toEqual([{ id: 'a' }]);
  });

  it('keeps a locally inserted assertion in place while new remote steps still arrive after it', () => {
    const local = [{ id: 'a' }, { id: 'assert', inserted: true }, { id: 'b' }];
    const remote = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const result = mergeRecordedSteps(local, remote, 2);
    expect(result).toEqual([
      { id: 'a' }, { id: 'assert', inserted: true }, { id: 'b' }, { id: 'c' },
    ]);
  });

  it('returns the local list unchanged when there are no new remote steps', () => {
    const local = [{ id: 'a' }, { id: 'b' }];
    const remote = [{ id: 'a' }, { id: 'b' }];
    expect(mergeRecordedSteps(local, remote, 2)).toEqual(local);
  });

  it('returns everything when receivedCount is 0 (first poll)', () => {
    const remote = [{ id: 'a' }, { id: 'b' }];
    expect(mergeRecordedSteps([], remote, 0)).toEqual(remote);
  });

  it('does not mutate the local array it was given', () => {
    const local = [{ id: 'a' }];
    const copy = [...local];
    mergeRecordedSteps(local, [{ id: 'a' }, { id: 'b' }], 1);
    expect(local).toEqual(copy);
  });
});
