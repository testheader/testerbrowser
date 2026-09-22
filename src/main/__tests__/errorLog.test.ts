import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeAppErrors, readAppErrors, AppErrorEntry } from '../errorLog';

function tempFile() {
  return path.join(os.tmpdir(), `app-errors-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const error1: AppErrorEntry = { ts: 1735732800000, message: 'Uncaught exception: boom' };
const error2: AppErrorEntry = { ts: 1735732801000, message: 'Chrome UI render process gone: crashed' };

describe('errorLog', () => {
  describe('durability across a fresh process', () => {
    it('recovers a recorded error after simulating a crashed process and a fresh one reading it back', () => {
      const file = tempFile();
      try {
        // "Crashed" process: records an error the way recordAppError() does
        // (index.ts), by write-through on every push — this is the only copy
        // that survives a hard crash, since its own in-memory array dies
        // with the process.
        let crashedProcessErrors: AppErrorEntry[] = [];
        crashedProcessErrors = [...crashedProcessErrors, error1];
        writeAppErrors(file, crashedProcessErrors);
        crashedProcessErrors = [...crashedProcessErrors, error2];
        writeAppErrors(file, crashedProcessErrors);
        // The crashed process dies here with no further code running —
        // nothing else touches `file` on its way out.

        // "Fresh" process: starts with its own empty in-memory array (as
        // index.ts's recentAppErrors does at module load) and must recover
        // the previous process's errors from disk instead.
        const freshProcessInMemoryErrors: AppErrorEntry[] = [];
        expect(freshProcessInMemoryErrors).toHaveLength(0);

        const recovered = readAppErrors(file);
        expect(recovered).toEqual([error1, error2]);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });
  });

  describe('writeAppErrors', () => {
    it('writes the full entries array as JSON', () => {
      const file = tempFile();
      try {
        writeAppErrors(file, [error1]);
        expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual([error1]);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it('overwrites (not appends) on each call, matching recordAppError()\'s capped in-memory array', () => {
      const file = tempFile();
      try {
        writeAppErrors(file, [error1]);
        writeAppErrors(file, [error1, error2]);
        expect(readAppErrors(file)).toEqual([error1, error2]);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it('does not throw when the target directory does not exist', () => {
      expect(() => writeAppErrors(path.join(tempFile(), 'nested', 'does-not-exist.json'), [error1])).not.toThrow();
    });
  });

  describe('readAppErrors', () => {
    it('returns an empty array when the file does not exist', () => {
      expect(readAppErrors(tempFile())).toEqual([]);
    });

    it('returns an empty array when the file contains invalid JSON', () => {
      const file = tempFile();
      try {
        fs.writeFileSync(file, 'not json');
        expect(readAppErrors(file)).toEqual([]);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it('returns an empty array when the file contains valid JSON that is not an array', () => {
      const file = tempFile();
      try {
        fs.writeFileSync(file, JSON.stringify({ oops: true }));
        expect(readAppErrors(file)).toEqual([]);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });
  });
});
