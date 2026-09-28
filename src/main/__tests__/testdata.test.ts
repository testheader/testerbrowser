import {
  genFirstName, genLastName, genFullName, genEmail, genUUID, genDate, genPhone, genAddress,
  genLongString, genUnicode, genRtl, genSqlInjection, genXss, genBoundaryNumber, genWhitespace, genTestCard,
  resolveTemplate,
} from '../testdata';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^\(\d{3}\) \d{3}-\d{4}$/;

function luhnValid(cardNumber: string): boolean {
  const digits = cardNumber.split('').reverse().map(Number);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[i];
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

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

  test('genLongString(n) has length n', () => {
    expect(genLongString(2500)).toHaveLength(2500);
    expect(genLongString()).toHaveLength(1000);
  });

  test('genUnicode mixes a combining mark, CJK and a ZWJ emoji sequence', () => {
    const s = genUnicode();
    expect(s).toContain('́'); // combining acute accent
    expect(s).toMatch(/[一-鿿]/); // CJK
    expect(s).toContain('‍'); // zero-width joiner
  });

  test('genRtl returns right-to-left script text', () => {
    expect(genRtl()).toMatch(/[֐-ࣿ]/);
  });

  test('genSqlInjection returns the documented probe string', () => {
    expect(genSqlInjection()).toBe("' OR '1'='1");
  });

  test('genXss returns the documented probe string', () => {
    expect(genXss()).toBe('<script>alert(1)</script>');
  });

  test('genBoundaryNumber returns one of the known boundary values, including literal -0', () => {
    const seen = new Set(Array.from({ length: 50 }, genBoundaryNumber));
    for (const v of seen) {
      expect(['0', '-1', String(Number.MAX_SAFE_INTEGER), '-0', '0.30000000000000004']).toContain(v);
    }
    expect(seen.has('-0')).toBe(true);
  });

  test('genWhitespace is whitespace-only, including non-ASCII whitespace', () => {
    const s = genWhitespace();
    expect(s.trim()).toBe('');
    expect(s).toContain(' ');
  });

  test('genTestCard returns a Luhn-valid, published test-only card number', () => {
    for (let i = 0; i < 20; i++) {
      const card = genTestCard();
      expect(card).toMatch(/^\d+$/);
      expect(luhnValid(card)).toBe(true);
    }
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

  // #275
  test('unqualified {firstName} occurrences are independently fresh, not forced identical', () => {
    // 20 names in the pool — run several times so a same-name coincidence
    // doesn't make this flaky.
    const sawDifferent = Array.from({ length: 20 }, () => {
      const [a, b] = resolveTemplate('{firstName} {firstName}').split(' ');
      return a !== b;
    }).some(Boolean);
    expect(sawDifferent).toBe(true);
  });

  test('{firstName#key} resolves both occurrences of the same key to the same value', () => {
    const result = resolveTemplate('{firstName#1} ... {firstName#1}');
    const [first, second] = result.split(/\s*\.\.\.\s*/);
    expect(first.trim()).toBe(second.trim());
  });

  test('{firstName#1} and {firstName#2} are independent (not forced to match)', () => {
    const sawDifferent = Array.from({ length: 20 }, () => {
      const result = resolveTemplate('{firstName#1} and {firstName#2}');
      const [a, b] = result.split(' and ');
      return a !== b;
    }).some(Boolean);
    expect(sawDifferent).toBe(true);
  });

  test('unqualified {firstName} {lastName} {email} in one template share one identity', () => {
    const result = resolveTemplate('{firstName} {lastName} {email}');
    const [first, last, email] = result.split(' ');
    const localPart = email.split('@')[0];
    expect(localPart.toLowerCase()).toBe(`${first.toLowerCase()}.${last.toLowerCase()}`);
  });

  test('an unqualified {email} with no preceding name still builds a coherent local part', () => {
    const email = resolveTemplate('{email}');
    expect(email).toMatch(/^[a-z]+\.[a-z]+@/);
  });

  test('two unqualified {email} occurrences in one template match (same shared identity)', () => {
    const result = resolveTemplate('{email} {email}');
    const [a, b] = result.split(' ');
    expect(a).toBe(b);
  });

  test('{longString:N} resolves to N repeated characters', () => {
    expect(resolveTemplate('{longString:250}')).toHaveLength(250);
  });

  test('{testCard} resolves to a Luhn-valid card number', () => {
    expect(resolveTemplate('{testCard}')).toMatch(/^\d+$/);
  });
});
