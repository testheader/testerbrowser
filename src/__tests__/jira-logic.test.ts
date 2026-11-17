import { adfText, extractAcceptanceCriteria, jiraHost } from '../../renderer/jira-logic.js';

const text = (t: string) => ({ type: 'text', text: t });
const para = (t: string) => ({ type: 'paragraph', content: [text(t)] });
const li = (t: string) => ({ type: 'listItem', content: [para(t)] });

describe('jira-logic (#314)', () => {
  it('adfText flattens nested ADF and plain strings', () => {
    expect(adfText(null)).toBe('');
    expect(adfText('plain')).toBe('plain');
    expect(adfText(para('Hello'))).toBe('Hello');
  });

  it('extractAcceptanceCriteria returns the list under the heading only', () => {
    const doc = { type: 'doc', content: [
      { type: 'heading', content: [text('Summary')] },
      { type: 'bulletList', content: [li('not me')] },
      { type: 'heading', content: [text('Acceptance criteria')] },
      { type: 'bulletList', content: [li('First'), li('Second')] },
      { type: 'heading', content: [text('Notes')] },
      { type: 'bulletList', content: [li('also not me')] },
    ] };
    expect(extractAcceptanceCriteria(doc)).toEqual(['First', 'Second']);
  });

  it('extractAcceptanceCriteria accepts a bold paragraph label and returns [] without one', () => {
    const doc = { type: 'doc', content: [para('Acceptance criteria:'), { type: 'orderedList', content: [li('One')] }] };
    expect(extractAcceptanceCriteria(doc)).toEqual(['One']);
    expect(extractAcceptanceCriteria({ type: 'doc', content: [para('nothing')] })).toEqual([]);
    expect(extractAcceptanceCriteria(null)).toEqual([]);
  });

  it('jiraHost returns the host or an empty string', () => {
    expect(jiraHost('https://acme.atlassian.net')).toBe('acme.atlassian.net');
    expect(jiraHost('not a url')).toBe('');
  });
});

import { formatBytes, recentComments, attachmentList } from '../../renderer/jira-logic.js';

describe('formatBytes', () => {
  it('formats B, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(50 * 1024)).toBe('50 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(-1)).toBe('');
  });
});

describe('recentComments', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
    author: { displayName: `U${i}` }, created: '2026-01-01T00:00:00.000+0000',
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `c${i}` }] }] },
  }));
  it('keeps the latest three, oldest first, and counts the hidden ones', () => {
    const r = recentComments({ comments: mk(5), total: 5 });
    expect(r.comments.map((c) => c.text)).toEqual(['c2', 'c3', 'c4']);
    expect(r.hidden).toBe(2);
  });
  it('counts comments beyond the payload via total', () => {
    expect(recentComments({ comments: mk(2), total: 10 }).hidden).toBe(8);
  });
  it('handles a missing comment field', () => {
    expect(recentComments(undefined)).toEqual({ comments: [], hidden: 0 });
  });
});

describe('attachmentList', () => {
  it('normalises attachments and drops nameless ones', () => {
    expect(attachmentList([{ filename: 'a.png', size: 10, content: 'https://x/a' }, {}, null]))
      .toEqual([{ filename: 'a.png', size: 10, url: 'https://x/a' }]);
    expect(attachmentList(undefined)).toEqual([]);
  });
});
