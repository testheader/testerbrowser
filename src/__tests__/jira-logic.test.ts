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
