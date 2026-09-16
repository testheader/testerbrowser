import {
  flattenAxTree, extractHeadings, extractLandmarks, findHeadingSkips, hasMainLandmark,
} from '../../renderer/a11y.js';

// A small synthetic AX tree, deliberately NOT in document order in the raw
// array (nodeId '4' — the h3 — appears before '3' — the h1 — the way CDP's
// own getFullAXTree response order is not guaranteed to match the DOM),
// mirroring the fixture #195's e2e test exercises: a banner, an h1 then an
// h3 (skipping h2), and a nav landmark, with no main.
const NODES = [
  { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['1', '2', '3'] },
  { nodeId: '4', role: { value: 'heading' }, name: { value: 'Skipped heading' },
    properties: [{ name: 'level', value: { value: 3 } }], backendDOMNodeId: 104, childIds: [] },
  { nodeId: '1', role: { value: 'banner' }, name: { value: 'Site header' }, backendDOMNodeId: 101, childIds: [] },
  { nodeId: '2', role: { value: 'heading' }, name: { value: 'Page title' },
    properties: [{ name: 'level', value: { value: 1 } }], backendDOMNodeId: 102, childIds: ['4'] },
  { nodeId: '3', role: { value: 'navigation' }, name: { value: '' }, backendDOMNodeId: 103, childIds: [] },
];

describe('flattenAxTree (#195 — heading & landmark outline)', () => {
  it('walks childIds depth-first from the root, regardless of raw array order', () => {
    const ordered = flattenAxTree(NODES);
    expect(ordered.map(n => n.nodeId)).toEqual(['root', '1', '2', '4', '3']);
  });

  it('returns an empty array for no nodes', () => {
    expect(flattenAxTree([])).toEqual([]);
    expect(flattenAxTree(undefined as unknown as [])).toEqual([]);
  });

  it('does not infinite-loop on a cyclic childIds reference', () => {
    const cyclic = [
      { nodeId: 'a', role: { value: 'RootWebArea' }, childIds: ['b'] },
      { nodeId: 'b', role: { value: 'generic' }, childIds: ['a'] },
    ];
    expect(flattenAxTree(cyclic).map(n => n.nodeId)).toEqual(['a', 'b']);
  });
});

describe('extractHeadings / extractLandmarks', () => {
  const ordered = flattenAxTree(NODES);

  it('extracts headings in document order with their level and name', () => {
    const headings = extractHeadings(ordered);
    expect(headings).toEqual([
      { backendDOMNodeId: 102, level: 1, name: 'Page title' },
      { backendDOMNodeId: 104, level: 3, name: 'Skipped heading' },
    ]);
  });

  it('extracts landmark-role nodes in document order', () => {
    const landmarks = extractLandmarks(ordered);
    expect(landmarks.map((l: { role: string }) => l.role)).toEqual(['banner', 'navigation']);
  });
});

describe('findHeadingSkips', () => {
  it('flags a jump of more than one level (h1 to h3)', () => {
    const headings = extractHeadings(flattenAxTree(NODES));
    const skips = findHeadingSkips(headings);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ fromLevel: 1, toLevel: 3 });
  });

  it('does not flag a normal h1 → h2 → h3 sequence', () => {
    const headings = [{ level: 1, name: 'a' }, { level: 2, name: 'b' }, { level: 3, name: 'c' }];
    expect(findHeadingSkips(headings)).toEqual([]);
  });

  it('never flags the first heading regardless of its level', () => {
    const headings = [{ level: 4, name: 'starts deep' }];
    expect(findHeadingSkips(headings)).toEqual([]);
  });
});

describe('hasMainLandmark', () => {
  it('is false when no landmark has role "main"', () => {
    const landmarks = extractLandmarks(flattenAxTree(NODES));
    expect(hasMainLandmark(landmarks)).toBe(false);
  });

  it('is true when a main landmark is present', () => {
    expect(hasMainLandmark([{ role: 'banner' }, { role: 'main' }])).toBe(true);
  });
});
