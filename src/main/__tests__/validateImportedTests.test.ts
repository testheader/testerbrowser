import { validateImportedTests } from '../recordingManager';

function validFile(tests: unknown[] = []) {
  return { testerBrowserTests: 1, tests };
}

describe('validateImportedTests (#274)', () => {
  it('accepts a valid file with a fully-populated test', () => {
    const result = validateImportedTests(validFile([
      {
        name: 'login flow',
        steps: [
          { type: 'navigate', url: 'https://example.com' },
          { type: 'fill', selector: '#user', value: 'ada' },
          { type: 'click', selector: '#submit' },
        ],
      },
    ]));

    expect(result.error).toBeUndefined();
    expect(result.skipped).toEqual([]);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].name).toBe('login flow');
    expect(result.tests[0].steps).toHaveLength(3);
    expect(result.tests[0].steps.map(s => s.type)).toEqual(['navigate', 'fill', 'click']);
  });

  it('regenerates a fresh id for every step, ignoring any id in the file', () => {
    const result = validateImportedTests(validFile([
      { name: 'a test', steps: [{ type: 'click', selector: '#x', id: 'attacker-supplied' }] },
    ]));
    expect(result.tests[0].steps[0].id).not.toBe('attacker-supplied');
    expect(typeof result.tests[0].steps[0].id).toBe('string');
    expect(result.tests[0].steps[0].id.length).toBeGreaterThan(0);
  });

  it('drops unknown fields from an otherwise-valid step', () => {
    const result = validateImportedTests(validFile([
      { name: 'a test', steps: [{ type: 'click', selector: '#x', extra: 'nope' }] },
    ]));
    expect(result.tests[0].steps[0]).not.toHaveProperty('extra');
  });

  it('rejects a file missing the testerBrowserTests marker', () => {
    const result = validateImportedTests({ tests: [] });
    expect(result.error).toBeTruthy();
    expect(result.tests).toEqual([]);
  });

  it('rejects a plain array (no marker at all)', () => {
    const result = validateImportedTests([{ name: 'x' }]);
    expect(result.error).toBeTruthy();
  });

  it('rejects null and primitives', () => {
    expect(validateImportedTests(null).error).toBeTruthy();
    expect(validateImportedTests('not json').error).toBeTruthy();
    expect(validateImportedTests(42).error).toBeTruthy();
  });

  it('rejects a file whose tests field is not an array', () => {
    const result = validateImportedTests({ testerBrowserTests: 1, tests: 'nope' });
    expect(result.error).toBeTruthy();
  });

  it('skips a test with an empty name, naming the index and reason', () => {
    const result = validateImportedTests(validFile([
      { name: '', steps: [] },
    ]));
    expect(result.tests).toEqual([]);
    expect(result.skipped).toEqual([{ index: 0, reason: expect.stringContaining('name') }]);
  });

  it('skips a test with a non-string name', () => {
    const result = validateImportedTests(validFile([{ name: 42, steps: [] }]));
    expect(result.skipped[0].reason).toContain('name');
  });

  it('skips a test whose steps is not an array', () => {
    const result = validateImportedTests(validFile([{ name: 'x', steps: 'nope' }]));
    expect(result.skipped[0].reason).toContain('steps');
  });

  it('skips a non-object test entry', () => {
    const result = validateImportedTests(validFile(['not-an-object']));
    expect(result.skipped[0]).toEqual({ index: 0, reason: expect.any(String) });
  });

  // A test's steps are an ordered sequence — dropping just the one bad step
  // (rather than the whole test) could misalign the rest against the wrong
  // page state, so the chosen behavior is to skip the entire test.
  it('skips the whole test, not just the one bad step, when a step has an unknown type', () => {
    const result = validateImportedTests(validFile([
      { name: 'x', steps: [{ type: 'click', selector: '#a' }, { type: 'not-a-real-type', selector: '#b' }] },
    ]));
    expect(result.tests).toEqual([]);
    expect(result.skipped).toEqual([{ index: 0, reason: expect.stringContaining('not-a-real-type') }]);
  });

  it('skips the whole test when a step is not an object', () => {
    const result = validateImportedTests(validFile([
      { name: 'x', steps: [{ type: 'click', selector: '#a' }, 'not-an-object'] },
    ]));
    expect(result.tests).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it('accepts every known step type', () => {
    const knownTypes = [
      'navigate', 'click', 'fill', 'check', 'assert-visible', 'assert-not-visible',
      'assert-text', 'assert-value', 'assert-url', 'assert-attr', 'assert-enabled',
      'wait-visible', 'wait-navigation',
    ];
    const result = validateImportedTests(validFile([
      { name: 'x', steps: knownTypes.map(type => ({ type, selector: '#a' })) },
    ]));
    expect(result.error).toBeUndefined();
    expect(result.skipped).toEqual([]);
    expect(result.tests[0].steps.map(s => s.type)).toEqual(knownTypes);
  });

  it('accepts an empty steps array', () => {
    const result = validateImportedTests(validFile([{ name: 'empty test', steps: [] }]));
    expect(result.tests).toEqual([{ name: 'empty test', steps: [] }]);
  });

  it('keeps valid tests and skips invalid ones from the same file, preserving original index', () => {
    const result = validateImportedTests(validFile([
      { name: 'good one', steps: [{ type: 'click', selector: '#a' }] },
      { name: '', steps: [] },
      { name: 'also good', steps: [{ type: 'navigate', url: 'https://x.example' }] },
    ]));

    expect(result.tests.map(t => t.name)).toEqual(['good one', 'also good']);
    expect(result.skipped).toEqual([{ index: 1, reason: expect.any(String) }]);
  });

  it('returns an empty result for an empty tests array', () => {
    const result = validateImportedTests(validFile([]));
    expect(result).toEqual({ tests: [], skipped: [] });
  });
});
