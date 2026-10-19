import {
  groupCommits,
  parseCommit,
  prependSection,
  renderBody,
  renderStatusBlock,
  replaceStatusBlock,
} from '../release-notes';

const commit = (subject: string, body = '') => ({ hash: 'abcdef1234567', subject, body });

describe('parseCommit', () => {
  it('reads type, scope and description from a conventional subject', () => {
    expect(parseCommit(commit('fix(sessions): keep pinned tabs'))).toMatchObject({
      type: 'fix',
      scope: 'sessions',
      breaking: false,
      description: 'keep pinned tabs',
    });
  });

  it('treats a bang as breaking', () => {
    expect(parseCommit(commit('feat!: drop the legacy API'))?.breaking).toBe(true);
  });

  it('treats a BREAKING CHANGE footer as breaking', () => {
    expect(parseCommit(commit('feat: new storage', 'BREAKING CHANGE: schema moved'))?.breaking).toBe(true);
  });

  it('files non-conventional subjects under other', () => {
    expect(parseCommit(commit('Update readme'))).toMatchObject({ type: 'other', description: 'Update readme' });
  });

  it('skips the bot version bump commits', () => {
    expect(parseCommit(commit('chore: bump version to 0.118.3'))).toBeNull();
  });
});

describe('groupCommits', () => {
  it('sorts commits into breaking, features, fixes and other', () => {
    const groups = groupCommits([
      parseCommit(commit('feat: a')),
      parseCommit(commit('fix: b')),
      parseCommit(commit('chore: c')),
      parseCommit(commit('feat!: d')),
      parseCommit(commit('chore: bump version to 1.0.0')),
    ]);
    expect(groups.breaking.map((c) => c?.description)).toEqual(['d']);
    expect(groups.features.map((c) => c?.description)).toEqual(['a']);
    expect(groups.fixes.map((c) => c?.description)).toEqual(['b']);
    expect(groups.other.map((c) => c?.description)).toEqual(['c']);
  });
});

describe('renderBody', () => {
  it('omits empty sections and shows a short hash per line', () => {
    const body = renderBody(groupCommits([parseCommit(commit('fix(ipc): tighten guard'))]));
    expect(body).toBe('### Fixes\n\n- **ipc:** tighten guard (abcdef1)');
  });

  it('says so when there is nothing to list', () => {
    expect(renderBody(groupCommits([]))).toBe('_No changes recorded._');
  });
});

describe('renderStatusBlock', () => {
  it('reports a pass when every job succeeded', () => {
    const block = renderStatusBlock(
      { 'bump-version': { result: 'success' }, e2e: { result: 'success' } },
      'https://example.test/run/1',
    );
    expect(block).toContain('**Build passed**');
    expect(block).toContain('- ✅ e2e: success');
    expect(block).toContain('[Workflow run](https://example.test/run/1)');
  });

  it('reports a failure and the job that failed', () => {
    const block = renderStatusBlock({ e2e: { result: 'failure' }, 'build-windows': { result: 'skipped' } }, null);
    expect(block).toContain('**Build did not pass**');
    expect(block).toContain('- ❌ e2e: failure');
    expect(block).toContain('- ➖ build-windows: skipped');
  });
});

describe('replaceStatusBlock', () => {
  const block = '<!-- build-status:start -->\nNEW\n<!-- build-status:end -->';

  it('appends a block to a body that has none', () => {
    expect(replaceStatusBlock('Notes\n', block)).toBe(`Notes\n\n${block}\n`);
  });

  it('replaces an existing block and leaves the rest of the body alone', () => {
    const old = '<!-- build-status:start -->\nOLD\n<!-- build-status:end -->';
    expect(replaceStatusBlock(`Top\n\n${old}\n`, block)).toBe(`Top\n\n${block}\n`);
  });
});

describe('prependSection', () => {
  it('puts the newest version directly under the title', () => {
    const existing = '# Changelog\n\n## v0.1.0 — 2026-01-01\n\nold\n';
    expect(prependSection(existing, '0.2.0', '## v0.2.0 — 2026-02-01\n\nnew')).toBe(
      '# Changelog\n\n## v0.2.0 — 2026-02-01\n\nnew\n\n## v0.1.0 — 2026-01-01\n\nold\n',
    );
  });

  it('creates the file header when starting from nothing', () => {
    expect(prependSection('', '0.1.0', '## v0.1.0 — 2026-01-01\n\nfirst')).toBe(
      '# Changelog\n\n## v0.1.0 — 2026-01-01\n\nfirst\n',
    );
  });

  it('does not add a section twice for the same version', () => {
    const existing = '# Changelog\n\n## v0.2.0 — 2026-02-01\n\nnew\n';
    expect(prependSection(existing, '0.2.0', '## v0.2.0 — 2026-02-01\n\nnew')).toBe(existing);
  });
});
