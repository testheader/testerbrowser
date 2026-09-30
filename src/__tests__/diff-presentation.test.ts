import {
  buildRequestMap, computeDiffRows,
  rowBucket, summarizeDiffRows, statusClassOf, rowStatusClasses, filterDiffRows,
  splitUrlForDisplay, splitChange, bodyTextForDiff, lineDiff,
} from '../../renderer/diff-logic.js';

type Cell = { label: string; count: number; cache: string } | null;
function row(category: string, a: Cell, b: Cell, extra: Record<string, unknown> = {}) {
  return { key: `${category}-${Math.random()}`, method: 'GET', url: 'https://x.test/api', a, b, category, headerBodyDiffer: false, detail: null, ...extra };
}
const cell = (label: string): Cell => ({ label, count: 1, cache: 'none' });

describe('rowBucket / summarizeDiffRows', () => {
  it('maps categories to changed/added/removed/unchanged, with a header/body difference counting as changed', () => {
    expect(rowBucket(row('diff', cell('200'), cell('500')))).toBe('changed');
    expect(rowBucket(row('only-a', cell('200'), null))).toBe('removed');
    expect(rowBucket(row('only-b', null, cell('200')))).toBe('added');
    expect(rowBucket(row('same', cell('200'), cell('200')))).toBe('unchanged');
    expect(rowBucket(row('same', cell('200'), cell('200'), { headerBodyDiffer: true }))).toBe('changed');
  });

  it('counts every bucket plus a total', () => {
    const rows = [
      row('diff', cell('200'), cell('500')),
      row('same', cell('200'), cell('200'), { headerBodyDiffer: true }),
      row('only-a', cell('200'), null),
      row('only-b', null, cell('404')),
      row('same', cell('200'), cell('200')),
      row('same', cell('304'), cell('304')),
    ];
    expect(summarizeDiffRows(rows)).toEqual({ changed: 2, added: 1, removed: 1, unchanged: 2, total: 6 });
  });
});

describe('statusClassOf / rowStatusClasses', () => {
  it('classifies status codes', () => {
    expect(statusClassOf(200)).toBe('2xx');
    expect(statusClassOf('302')).toBe('3xx');
    expect(statusClassOf('404')).toBe('4xx');
    expect(statusClassOf('503')).toBe('5xx');
    expect(statusClassOf('FAILED')).toBe('failed');
    expect(statusClassOf('101')).toBe('other');
  });

  it('collects classes from both sides, including multi-status grouped labels', () => {
    expect([...rowStatusClasses(row('diff', cell('200/304'), cell('500')))].sort()).toEqual(['2xx', '3xx', '5xx']);
    expect([...rowStatusClasses(row('only-b', null, cell('FAILED')))]).toEqual(['failed']);
  });
});

describe('filterDiffRows', () => {
  const rows = [
    row('diff', cell('200'), cell('500'), { url: 'https://x.test/api/users' }),
    row('only-a', cell('404'), null, { url: 'https://x.test/api/legacy' }),
    row('same', cell('200'), cell('200'), { url: 'https://x.test/analytics/beacon' }),
  ];

  it('filters by bucket', () => {
    const out = filterDiffRows(rows, { buckets: new Set(['changed', 'removed']) });
    expect(out.map(r => r.category)).toEqual(['diff', 'only-a']);
  });

  it('filters by status class on either side', () => {
    expect(filterDiffRows(rows, { statusClasses: new Set(['5xx']) }).map(r => r.category)).toEqual(['diff']);
    expect(filterDiffRows(rows, { statusClasses: new Set(['4xx']) }).map(r => r.category)).toEqual(['only-a']);
  });

  it('never hides a row whose statuses are all unclassifiable', () => {
    const odd = [row('same', cell('101'), cell('101'))];
    expect(filterDiffRows(odd, { statusClasses: new Set(['2xx']) })).toHaveLength(1);
  });

  it('applies free-text URL terms, including -negation', () => {
    expect(filterDiffRows(rows, { text: 'api' })).toHaveLength(2);
    expect(filterDiffRows(rows, { text: '-analytics' })).toHaveLength(2);
    expect(filterDiffRows(rows, { text: 'api -legacy' }).map(r => r.url)).toEqual(['https://x.test/api/users']);
  });

  it('with no options returns every row', () => {
    expect(filterDiffRows(rows)).toHaveLength(3);
  });
});

describe('splitUrlForDisplay', () => {
  it('separates origin from path+query', () => {
    expect(splitUrlForDisplay('https://api.example.com:8443/v1/items?page=2#top'))
      .toEqual({ host: 'https://api.example.com:8443', path: '/v1/items?page=2#top' });
  });

  it('falls back to the raw string for an unparseable or host-less URL', () => {
    expect(splitUrlForDisplay('not a url')).toEqual({ host: '', path: 'not a url' });
    expect(splitUrlForDisplay('data:text/plain,hi')).toEqual({ host: '', path: 'data:text/plain,hi' });
  });
});

describe('splitChange', () => {
  it('isolates the differing middle', () => {
    expect(splitChange('max-age=60, public', 'max-age=3600, public'))
      .toEqual({ prefix: 'max-age=', midA: '6', midB: '360', suffix: '0, public' });
  });

  it('does not let prefix and suffix overlap', () => {
    const r = splitChange('aa', 'aaa');
    expect(r.prefix + r.midA + r.suffix).toBe('aa');
    expect(r.prefix + r.midB + r.suffix).toBe('aaa');
  });

  it('handles completely different values', () => {
    expect(splitChange('abc', 'xyz')).toEqual({ prefix: '', midA: 'abc', midB: 'xyz', suffix: '' });
  });
});

describe('bodyTextForDiff', () => {
  it('pretty-prints JSON so a one-line response diffs per field', () => {
    expect(bodyTextForDiff({ body: '{"a":1,"b":2}', base64Encoded: false })).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it('returns plain text as-is and null for base64/missing bodies', () => {
    expect(bodyTextForDiff({ body: 'hello', base64Encoded: false })).toBe('hello');
    expect(bodyTextForDiff({ body: 'aGk=', base64Encoded: true })).toBeNull();
    expect(bodyTextForDiff(null)).toBeNull();
  });
});

describe('lineDiff', () => {
  it('reports identical texts as identical', () => {
    expect(lineDiff('a\nb', 'a\nb')).toMatchObject({ identical: true, lines: [] });
  });

  it('marks removed and added lines with surrounding context and collapses the rest', () => {
    const a = ['1', '2', '3', '4', '5', 'old', '7', '8', '9', '10'].join('\n');
    const b = ['1', '2', '3', '4', '5', 'new', '7', '8', '9', '10'].join('\n');
    const { lines } = lineDiff(a, b, { context: 1 });
    expect(lines).toEqual([
      { type: 'gap', count: 4 },
      { type: ' ', text: '5' },
      { type: '-', text: 'old' },
      { type: '+', text: 'new' },
      { type: ' ', text: '7' },
      { type: 'gap', count: 3 },
    ]);
  });

  it('handles pure insertions', () => {
    const { lines } = lineDiff('a\nc', 'a\nb\nc');
    expect(lines).toEqual([{ type: ' ', text: 'a' }, { type: '+', text: 'b' }, { type: ' ', text: 'c' }]);
  });

  it('caps output at maxLines', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join('\n');
    const r = lineDiff(a, b, { maxLines: 10 });
    expect(r.truncated).toBe(true);
    expect(r.lines).toHaveLength(10);
  });

  it('bails out with the first differing line when too large for an LCS', () => {
    const r = lineDiff('same\nx\ny', 'same\np\nq', { maxCells: 4 });
    expect(r).toMatchObject({ tooLarge: true, firstDiffLine: 2 });
  });
});

describe('buildRequestMap / computeDiffRows: request data for Copy as cURL', () => {
  const ev = (kind: string, payload: unknown) => ({ kind, ts: 0, summary: '', payload: JSON.stringify(payload) });

  it('keeps each side\'s request method/url/headers/postData on the row, and body refs on the detail', () => {
    const evA = [
      ev('network-request', { requestId: '1', request: { method: 'POST', url: 'https://a.test/api?x=1', headers: { 'Content-Type': 'application/json' }, postData: '{"q":1}' } }),
      ev('network-response', { requestId: '1', response: { status: 200, headers: {} } }),
      ev('network-body', { requestId: '1', body: '{"ok":true}', base64Encoded: false }),
    ];
    const evB = [
      ev('network-request', { requestId: '9', request: { method: 'POST', url: 'https://a.test/api?x=1', headers: {} } }),
      ev('network-response', { requestId: '9', response: { status: 500, headers: {} } }),
    ];
    const [r] = computeDiffRows(buildRequestMap(evA), buildRequestMap(evB));
    expect(r.requestA).toEqual({ method: 'POST', url: 'https://a.test/api?x=1', headers: { 'Content-Type': 'application/json' }, postData: '{"q":1}' });
    expect(r.requestB).toEqual({ method: 'POST', url: 'https://a.test/api?x=1', headers: {}, postData: null });
    expect(r.detail?.bodyA).toEqual({ body: '{"ok":true}', base64Encoded: false });
    expect(r.detail?.bodyB).toBeNull();
  });

  it('an only-in-A row has requestA but no requestB', () => {
    const evA = [
      ev('network-request', { requestId: '1', request: { method: 'GET', url: 'https://a.test/x' } }),
      ev('network-response', { requestId: '1', response: { status: 200, headers: {} } }),
    ];
    const [r] = computeDiffRows(buildRequestMap(evA), buildRequestMap([]));
    expect(r.requestA).toMatchObject({ method: 'GET', url: 'https://a.test/x', headers: {} });
    expect(r.requestB).toBeNull();
  });
});
