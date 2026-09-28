function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

const FIRST_NAMES = ['Alice','Bob','Carol','Dave','Eve','Frank','Grace','Henry','Iris','Jack','Karen','Liam','Mia','Noah','Olivia','Paul','Quinn','Rose','Sam','Tina'];
const LAST_NAMES  = ['Smith','Jones','Williams','Brown','Taylor','Davis','Miller','Wilson','Moore','Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Garcia','Martinez','Robinson','Clark'];
const DOMAINS     = ['example.com','test.org','demo.net','sample.io','mock.dev'];
const STREETS     = ['Main St','Oak Ave','Maple Dr','Cedar Blvd','Elm Way','Park Lane','Lake Rd','Hill Ct'];
const CITIES      = ['Springfield','Riverside','Greenville','Madison','Franklin','Clinton'];

export function genFirstName() { return pick(FIRST_NAMES); }
export function genLastName()  { return pick(LAST_NAMES); }
export function genFullName()  { return `${genFirstName()} ${genLastName()}`; }
export function genEmail()     { return `${genFirstName().toLowerCase()}.${genLastName().toLowerCase()}@${pick(DOMAINS)}`; }
export function genUUID()      { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); }
export function genDate()      { return new Date().toISOString().split('T')[0]; }
export function genPhone()     { return `(${200 + (Math.random() * 800 | 0)}) ${100 + (Math.random() * 900 | 0)}-${1000 + (Math.random() * 9000 | 0)}`; }
export function genAddress()   { return `${100 + (Math.random() * 9900 | 0)} ${pick(STREETS)}, ${pick(CITIES)}`; }

// #275: edge-case generators, for probing input validation/escaping in the
// app under test — a tester's toolbox, not an attack surface against
// TesterBrowser itself.
export function genLongString(n = 1000) { return 'x'.repeat(n); }
// A combining-mark accent (base "e" + U+0301), CJK, and a ZWJ emoji sequence
// (family: man-woman-girl-boy) — the three unicode edge cases that most
// commonly break naive string-length or truncation logic.
export function genUnicode()   { return 'café 世界 👨‍👩‍👧‍👦'; }
export function genRtl()       { return pick(['مرحبا بالعالم', 'שלום עולם']); }
export function genSqlInjection() { return "' OR '1'='1"; }
export function genXss()       { return '<script>alert(1)</script>'; }
// -0 is deliberately spelled out rather than String(-0) (which yields "0")
// — the point of including it is testing code that mishandles negative zero.
const BOUNDARY_NUMBERS = ['0', '-1', String(Number.MAX_SAFE_INTEGER), '-0', '0.30000000000000004'];
export function genBoundaryNumber() { return pick(BOUNDARY_NUMBERS); }
// A couple of "exotic" Unicode whitespace characters (no-break space, em
// space) alongside ordinary space/tab, so a field that only trims ASCII
// whitespace visibly fails to treat this as empty.
export function genWhitespace() { return ' \t   '; }
// Published test-only card numbers (never real card number patterns) —
// https://docs.stripe.com/testing#cards — each is Luhn-valid by design.
const TEST_CARDS = ['4242424242424242', '5555555555554444', '378282246310005', '6011111111111117'];
export function genTestCard()  { return pick(TEST_CARDS); }

interface Identity { firstName: string; lastName: string }

function buildEmail(id: Identity): string {
  return `${id.firstName.toLowerCase()}.${id.lastName.toLowerCase()}@${pick(DOMAINS)}`;
}

// Type name (lowercased) -> a fresh value generator, for every placeholder
// that has no cross-field identity to maintain. firstName/lastName/fullName/
// email are handled separately in resolveTemplate itself, since they need
// access to the per-template identity state below.
const FRESH_GENERATORS: Record<string, (param?: string) => string> = {
  uuid: genUUID,
  date: genDate,
  phone: genPhone,
  address: genAddress,
  longstring: (param) => genLongString(param ? parseInt(param, 10) : undefined),
  unicode: genUnicode,
  rtl: genRtl,
  sqlinjection: genSqlInjection,
  xss: genXss,
  boundarynumber: genBoundaryNumber,
  whitespace: genWhitespace,
  testcard: genTestCard,
};

// #275: placeholders are `{type}`, `{type#key}` or `{type:param}` (a
// `{type#key:param}` combination is allowed too, matching this order).
// - Bare `{type}`: a fresh value every occurrence, independent of every
//   other occurrence — except firstName/lastName/fullName/email, which are
//   a deliberate exception (see below).
// - `{type#key}`: the *first* occurrence of a given (type, key) pair
//   generates a value; every later occurrence of that exact pair reuses it
//   verbatim. Different keys are independent, so `{firstName#1}` and
//   `{firstName#2}` are two unrelated names.
// - firstName/lastName/fullName/email identity: within one call, all the
//   *unqualified* occurrences of these four describe one coherent person —
//   an unqualified {email} builds its local part from whatever first/last
//   name the template has established so far (generating one on the spot
//   if neither has appeared yet), not from an independently-generated name.
//   firstName/lastName themselves still generate fresh on every unqualified
//   occurrence (two `{firstName}`s in one template are still two different
//   names) — they just also update the shared identity for a later email/
//   fullName to pick up. A `#key` scopes this identity the same way it
//   scopes the cache above, so `{firstName#1}`/`{email#1}` describe one
//   person and `{firstName#2}`/`{email#2}` describe a different one.
const PLACEHOLDER_RE = /\{(\w+)(?:#(\w+))?(?::(\d+))?\}/g;

export function resolveTemplate(tpl: string): string {
  const identities = new Map<string, Identity>();
  const refCache = new Map<string, string>();
  const derivedCache = new Map<string, string>();

  function getIdentity(key: string): Identity {
    let id = identities.get(key);
    if (!id) {
      id = { firstName: genFirstName(), lastName: genLastName() };
      identities.set(key, id);
    }
    return id;
  }

  return tpl.replace(PLACEHOLDER_RE, (full, rawType: string, key: string | undefined, param: string | undefined) => {
    const type = rawType.toLowerCase();

    if (key) {
      const cacheKey = `${type}#${key}`;
      const cached = refCache.get(cacheKey);
      if (cached !== undefined) return cached;

      let value: string;
      if (type === 'firstname') {
        value = genFirstName();
        getIdentity(key).firstName = value;
      } else if (type === 'lastname') {
        value = genLastName();
        getIdentity(key).lastName = value;
      } else if (type === 'fullname') {
        const id = getIdentity(key);
        value = `${id.firstName} ${id.lastName}`;
      } else if (type === 'email') {
        value = buildEmail(getIdentity(key));
      } else {
        const gen = FRESH_GENERATORS[type];
        if (!gen) return full;
        value = gen(param);
      }
      refCache.set(cacheKey, value);
      return value;
    }

    // Unqualified.
    if (type === 'firstname') {
      const value = genFirstName();
      getIdentity('').firstName = value;
      return value;
    }
    if (type === 'lastname') {
      const value = genLastName();
      getIdentity('').lastName = value;
      return value;
    }
    if (type === 'fullname') {
      const cached = derivedCache.get('fullname');
      if (cached !== undefined) return cached;
      const id = getIdentity('');
      const value = `${id.firstName} ${id.lastName}`;
      derivedCache.set('fullname', value);
      return value;
    }
    if (type === 'email') {
      const cached = derivedCache.get('email');
      if (cached !== undefined) return cached;
      const value = buildEmail(getIdentity(''));
      derivedCache.set('email', value);
      return value;
    }

    const gen = FRESH_GENERATORS[type];
    return gen ? gen(param) : full;
  });
}
