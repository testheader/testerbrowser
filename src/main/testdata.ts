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

export function resolveTemplate(tpl: string): string {
  return tpl
    .replace(/\{firstName\}/gi, genFirstName())
    .replace(/\{lastName\}/gi, genLastName())
    .replace(/\{email\}/gi, genEmail())
    .replace(/\{uuid\}/gi, genUUID())
    .replace(/\{date\}/gi, genDate())
    .replace(/\{phone\}/gi, genPhone())
    .replace(/\{address\}/gi, genAddress());
}
