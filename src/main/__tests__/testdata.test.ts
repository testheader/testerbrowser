import { genFirstName, genLastName, genFullName, genEmail, genUUID, genDate, genPhone, genAddress, resolveTemplate } from '../testdata';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^\(\d{3}\) \d{3}-\d{4}$/;

describe('test data generators', () => {
  test('genFirstName returns a non-empty string', () => {
    expect(typeof genFirstName()).toBe('string');
    expect(genFirstName().length).toBeGreaterThan(0);
  });

  test('genLastName returns a non-empty string', () => {
    expect(genLastName().length).toBeGreaterThan(0);
  });

  test('genFullName contains a space', () => {
    expect(genFullName()).toContain(' ');
  });

  test('genEmail contains @ and a dot in the domain', () => {
    const email = genEmail();
    expect(email).toContain('@');
    expect(email.split('@')[1]).toContain('.');
  });

  test('genUUID matches UUID v4 format', () => {
    expect(genUUID()).toMatch(UUID_RE);
  });

  test('genDate matches YYYY-MM-DD format', () => {
    expect(genDate()).toMatch(DATE_RE);
  });

  test('genPhone matches (NNN) NNN-NNNN format', () => {
    expect(genPhone()).toMatch(PHONE_RE);
  });

  test('genAddress returns a non-empty string with a comma', () => {
    expect(genAddress()).toContain(',');
  });
});

describe('resolveTemplate', () => {
  test('replaces {firstName} with a non-empty string', () => {
    const result = resolveTemplate('{firstName}');
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain('{firstName}');
  });

  test('replaces {email} with a string containing @', () => {
    const result = resolveTemplate('{email}');
    expect(result).toContain('@');
  });

  test('replaces {uuid} with a UUID v4', () => {
    expect(resolveTemplate('{uuid}')).toMatch(UUID_RE);
  });

  test('handles mixed template', () => {
    const result = resolveTemplate('Hello {firstName} {lastName}, your ID is {uuid}');
    expect(result).not.toContain('{firstName}');
    expect(result).not.toContain('{lastName}');
    expect(result).not.toContain('{uuid}');
    expect(result).toMatch(/Hello \w+ \w+, your ID is [0-9a-f-]+/);
  });

  test('leaves unknown tokens unchanged', () => {
    expect(resolveTemplate('{unknown}')).toBe('{unknown}');
  });
});
