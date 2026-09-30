import {
  formatAppLogBlockText, buildDefaultDiagnosticsText, wrapDiagnosticsMarkdown,
  buildBugReportTitle, findProjectBoardId, projectItemWasAdded, DiagnosticsSummary,
} from '../bugReportFormat';

describe('formatAppLogBlockText (#280)', () => {
  it('wraps the log text in a <details> block with a line count in the summary', () => {
    const result = formatAppLogBlockText({ text: 'line1\nline2\nline3', truncated: false });
    expect(result).toContain('<summary>App log (last 3 lines)</summary>');
    expect(result).toContain('line1\nline2\nline3');
  });

  it('notes truncation in the summary when the log was capped', () => {
    const result = formatAppLogBlockText({ text: 'a', truncated: true });
    expect(result).toContain('App log (last 1 lines, truncated)');
  });

  it('reports 0 lines for empty log text', () => {
    const result = formatAppLogBlockText({ text: '', truncated: false });
    expect(result).toContain('App log (last 0 lines)');
  });
});

describe('buildDefaultDiagnosticsText (#280)', () => {
  const base: DiagnosticsSummary = {
    version: '1.2.3',
    electron: '30.0.0',
    chrome: '124.0',
    node: '20.0.0',
    platform: 'linux',
    arch: 'x64',
    osRelease: '6.1.0',
    recentErrors: [],
    appLog: { text: '', truncated: false },
  };

  it('reports "No recent app errors recorded." when there are none', () => {
    const text = buildDefaultDiagnosticsText(base);
    expect(text).toContain('No recent app errors recorded.');
    expect(text).not.toContain('Recent app errors:');
  });

  it('lists recent errors, most fields included, when present', () => {
    const text = buildDefaultDiagnosticsText({
      ...base,
      recentErrors: [{ ts: 1700000000000, message: 'boom' }],
    });
    expect(text).toContain('Recent app errors:');
    expect(text).toContain('boom');
    expect(text).not.toContain('No recent app errors recorded.');
  });

  it('includes version/platform/electron/chrome/node identifiers', () => {
    const text = buildDefaultDiagnosticsText(base);
    expect(text).toContain('TesterBrowser: 1.2.3');
    expect(text).toContain('Electron: 30.0.0  Chrome: 124.0  Node: 20.0.0');
    expect(text).toContain('linux x64 (6.1.0)');
  });

  it('embeds the formatted app-log block', () => {
    const text = buildDefaultDiagnosticsText({ ...base, appLog: { text: 'log line', truncated: false } });
    expect(text).toContain('log line');
    expect(text).toContain('<details><summary>App log');
  });
});

describe('wrapDiagnosticsMarkdown (#280)', () => {
  it('wraps the feature area and text in a <details> code block', () => {
    const result = wrapDiagnosticsMarkdown('Console', 'some diagnostics text');
    expect(result).toContain('<details><summary>Diagnostics</summary>');
    expect(result).toContain('Feature area: Console');
    expect(result).toContain('some diagnostics text');
    expect(result).toContain('```');
  });
});

describe('buildBugReportTitle (#280)', () => {
  it('prefixes the area and uses the first line of the description', () => {
    expect(buildBugReportTitle('Console', 'Errors do not appear\nsecond line')).toBe('[Console] Errors do not appear');
  });

  it('trims leading whitespace from the description, and only the description\'s own leading/trailing whitespace (not each line\'s)', () => {
    // .trim() runs on the whole description before the split, so a line's
    // own internal trailing whitespace (here, before the \n) survives.
    expect(buildBugReportTitle('Network', '   spaced out   \nmore')).toBe('[Network] spaced out   ');
  });

  it('truncates a long first line to 80 characters', () => {
    const long = 'x'.repeat(200);
    const title = buildBugReportTitle('Storage', long);
    expect(title).toBe(`[Storage] ${'x'.repeat(80)}`);
  });

  it('leaves a short single-line description untouched', () => {
    expect(buildBugReportTitle('Downloads', 'short')).toBe('[Downloads] short');
  });
});

describe('findProjectBoardId (#280)', () => {
  it('finds a board whose title matches "testerbrowser" case-insensitively', () => {
    const nodes = [{ id: 'p1', title: 'Other board' }, { id: 'p2', title: 'TesterBrowser' }];
    expect(findProjectBoardId(nodes)).toBe('p2');
  });

  it('matches a substring, not just an exact title', () => {
    const nodes = [{ id: 'p1', title: 'testerbrowser roadmap' }];
    expect(findProjectBoardId(nodes)).toBe('p1');
  });

  it('returns null when no board matches', () => {
    expect(findProjectBoardId([{ id: 'p1', title: 'Unrelated' }])).toBeNull();
  });

  it('returns null for an empty node list', () => {
    expect(findProjectBoardId([])).toBeNull();
  });
});

describe('projectItemWasAdded (#280)', () => {
  it('returns true when the mutation response carries an item id', () => {
    expect(projectItemWasAdded({ data: { addProjectV2ItemById: { item: { id: 'item-1' } } } })).toBe(true);
  });

  it('returns false when item is missing', () => {
    expect(projectItemWasAdded({ data: { addProjectV2ItemById: { item: null } } })).toBe(false);
  });

  it('returns false when addProjectV2ItemById is missing', () => {
    expect(projectItemWasAdded({ data: {} })).toBe(false);
  });

  it('returns false for null/undefined input', () => {
    expect(projectItemWasAdded(null)).toBe(false);
    expect(projectItemWasAdded(undefined)).toBe(false);
  });
});
