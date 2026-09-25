import fs from 'fs';
import os from 'os';
import path from 'path';
import { readJsonWithBackup, writeJsonAtomic } from '../jsonFile';

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `json-file-test-${name}-`));
  return path.join(dir, `${name}.json`);
}

describe('writeJsonAtomic (#248)', () => {
  it('produces a valid, readable file', () => {
    const file = tmpFile('write-basic');
    writeJsonAtomic(file, { a: 1 });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ a: 1 });
  });

  it('backs up the previous content to .bak before overwriting', () => {
    const file = tmpFile('write-bak');
    writeJsonAtomic(file, { a: 1 });
    writeJsonAtomic(file, { a: 2 });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ a: 2 });
    expect(JSON.parse(fs.readFileSync(file + '.bak', 'utf-8'))).toEqual({ a: 1 });
  });

  it('does not leave a .tmp file behind after a successful write', () => {
    const file = tmpFile('write-no-tmp');
    writeJsonAtomic(file, { a: 1 });
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });

  it('does not create a .bak on the very first write (nothing to back up yet)', () => {
    const file = tmpFile('write-first');
    writeJsonAtomic(file, { a: 1 });
    expect(fs.existsSync(file + '.bak')).toBe(false);
  });

  it('never throws, even when the target directory does not exist', () => {
    const file = path.join(os.tmpdir(), `json-file-test-missing-dir-${Date.now()}`, 'settings.json');
    expect(() => writeJsonAtomic(file, { a: 1 })).not.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('readJsonWithBackup (#248)', () => {
  it('reads the main file when it parses', () => {
    const file = tmpFile('read-main');
    fs.writeFileSync(file, JSON.stringify({ a: 1 }));
    expect(readJsonWithBackup(file)).toEqual({ ok: true, data: { a: 1 }, source: 'main' });
  });

  it('falls back to .bak when the main file is missing', () => {
    const file = tmpFile('read-missing-main');
    fs.writeFileSync(file + '.bak', JSON.stringify({ a: 'from-backup' }));
    expect(readJsonWithBackup(file)).toEqual({ ok: true, data: { a: 'from-backup' }, source: 'backup' });
  });

  it('falls back to .bak when the main file is truncated/corrupt', () => {
    const file = tmpFile('read-truncated-main');
    fs.writeFileSync(file, '{"a": tru'); // truncated mid-write
    fs.writeFileSync(file + '.bak', JSON.stringify({ a: 'good-backup' }));
    expect(readJsonWithBackup(file)).toEqual({ ok: true, data: { a: 'good-backup' }, source: 'backup' });
  });

  it('reports failure when both the main file and .bak are missing/unparsable', () => {
    const file = tmpFile('read-both-bad');
    fs.writeFileSync(file, 'not json');
    fs.writeFileSync(file + '.bak', 'also not json');
    expect(readJsonWithBackup(file)).toEqual({ ok: false });
  });

  it('reports failure when neither file exists at all', () => {
    const file = tmpFile('read-neither-exists');
    expect(readJsonWithBackup(file)).toEqual({ ok: false });
  });
});

describe('writeJsonAtomic + readJsonWithBackup round trip (#248)', () => {
  it('a truncated main file with a good .bak (simulating a crash mid-write) recovers the last-known-good content', () => {
    const file = tmpFile('round-trip-crash');
    writeJsonAtomic(file, { version: 1 });
    writeJsonAtomic(file, { version: 2 }); // .bak now holds version 1
    // Simulate a crash mid-write: the main file is left truncated.
    fs.writeFileSync(file, '{"version": trunc');

    const result = readJsonWithBackup(file);
    expect(result).toEqual({ ok: true, data: { version: 1 }, source: 'backup' });
  });
});
