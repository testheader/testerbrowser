import { buildPlaybackScript, dataAttrSelector } from '../sessionManager';
import type { TestStep } from '../sessionManager';

function makeStep(overrides: Partial<TestStep> = {}): TestStep {
  return {
    id: 's1',
    type: 'click',
    selector: '#target',
    ...overrides,
  };
}

describe('dataAttrSelector (#242 — genSel names the attribute that actually matched)', () => {
  it('returns a data-testid selector when that attribute is present', () => {
    const attrs: Record<string, string> = { 'data-testid': 'submit' };
    expect(dataAttrSelector((name) => attrs[name] ?? null)).toBe('[data-testid="submit"]');
  });

  it('returns a data-cy selector when only data-cy is present — not data-testid', () => {
    const attrs: Record<string, string> = { 'data-cy': 'submit' };
    expect(dataAttrSelector((name) => attrs[name] ?? null)).toBe('[data-cy="submit"]');
  });

  it('returns a data-test selector when only data-test is present', () => {
    const attrs: Record<string, string> = { 'data-test': 'submit' };
    expect(dataAttrSelector((name) => attrs[name] ?? null)).toBe('[data-test="submit"]');
  });

  it('returns a data-qa selector when only data-qa is present', () => {
    const attrs: Record<string, string> = { 'data-qa': 'submit' };
    expect(dataAttrSelector((name) => attrs[name] ?? null)).toBe('[data-qa="submit"]');
  });

  it('respects priority order when more than one is present', () => {
    const attrs: Record<string, string> = { 'data-cy': 'cy-value', 'data-testid': 'testid-value' };
    expect(dataAttrSelector((name) => attrs[name] ?? null)).toBe('[data-testid="testid-value"]');
  });

  it('escapes backslashes and double quotes in the attribute value', () => {
    const attrs: Record<string, string> = { 'data-cy': 'a"b\\c' };
    expect(dataAttrSelector((name) => attrs[name] ?? null)).toBe('[data-cy="a\\"b\\\\c"]');
  });

  it('returns null when none of the four attributes are present', () => {
    expect(dataAttrSelector(() => null)).toBeNull();
  });
});

describe('buildPlaybackScript — sensitive fill steps never type the literal placeholder (#242)', () => {
  it('fails loudly instead of typing "[hidden]" when a sensitive step reaches playback un-substituted', () => {
    const script = buildPlaybackScript(makeStep({ type: 'fill', sensitive: true, value: '[hidden]' }));
    expect(script).not.toContain('[hidden]');
    expect(script).toContain('should have been substituted before playback');
  });

  it('fails loudly when a sensitive step has no value at all', () => {
    const script = buildPlaybackScript(makeStep({ type: 'fill', sensitive: true }));
    expect(script).toContain('should have been substituted before playback');
  });

  it('types the real value once the caller has substituted it onto a copy of the step', () => {
    const script = buildPlaybackScript(makeStep({ type: 'fill', sensitive: true, value: 'correct-horse-battery-staple' }));
    expect(script).toContain('correct-horse-battery-staple');
    expect(script).not.toContain('should have been substituted');
  });

  it('a non-sensitive fill types its value normally', () => {
    const script = buildPlaybackScript(makeStep({ type: 'fill', value: 'Ada' }));
    expect(script).toContain('el.value=');
    expect(script).toContain('"Ada"');
  });
});

describe('buildPlaybackScript — check step type (#242)', () => {
  it('sets el.checked = true for a checked step', () => {
    const script = buildPlaybackScript(makeStep({ type: 'check', value: true }));
    expect(script).toContain('el.checked=true');
  });

  it('sets el.checked = false for an unchecked step', () => {
    const script = buildPlaybackScript(makeStep({ type: 'check', value: false }));
    expect(script).toContain('el.checked=false');
  });

  it('dispatches input and change events, matching the fill case\'s pattern', () => {
    const script = buildPlaybackScript(makeStep({ type: 'check', value: true }));
    expect(script).toContain("new Event('input'");
    expect(script).toContain("new Event('change'");
  });
});
