import { compareTabOrder, TabOrderCandidate } from '../sessionManager';

describe('compareTabOrder (#197 — focus order overlay)', () => {
  it('orders positive-tabindex elements first, ascending', () => {
    const items: TabOrderCandidate[] = [
      { tabindex: 0, domIndex: 0 },
      { tabindex: 2, domIndex: 1 },
      { tabindex: 1, domIndex: 2 },
    ];
    const sorted = [...items].sort(compareTabOrder);
    expect(sorted).toEqual([
      { tabindex: 1, domIndex: 2 },
      { tabindex: 2, domIndex: 1 },
      { tabindex: 0, domIndex: 0 },
    ]);
  });

  it('breaks ties within the same positive tabindex by DOM order', () => {
    const items: TabOrderCandidate[] = [
      { tabindex: 1, domIndex: 2 },
      { tabindex: 1, domIndex: 0 },
      { tabindex: 1, domIndex: 1 },
    ];
    const sorted = [...items].sort(compareTabOrder);
    expect(sorted.map(i => i.domIndex)).toEqual([0, 1, 2]);
  });

  it('places all tabindex-0/natural elements after every positive tabindex, in DOM order', () => {
    const items: TabOrderCandidate[] = [
      { tabindex: 0, domIndex: 5 },
      { tabindex: 3, domIndex: 0 },
      { tabindex: 0, domIndex: 1 },
    ];
    const sorted = [...items].sort(compareTabOrder);
    expect(sorted.map(i => i.domIndex)).toEqual([0, 1, 5]);
  });

  it('matches the ticket example: tabindex=2 before tabindex=1 in markup still sorts 1 before 2', () => {
    const items: TabOrderCandidate[] = [
      { tabindex: 2, domIndex: 0 }, // appears first in the DOM
      { tabindex: 1, domIndex: 1 }, // appears second in the DOM
      { tabindex: 0, domIndex: 2 }, // plain DOM-order button, appears last
    ];
    const sorted = [...items].sort(compareTabOrder);
    expect(sorted.map(i => i.domIndex)).toEqual([1, 0, 2]);
  });
});
