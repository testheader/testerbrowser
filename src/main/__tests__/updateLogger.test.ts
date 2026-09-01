import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeUpdateLog, readUpdateLog, UpdateLogEntry } from '../updateLogger';

function tempFile() {
  return path.join(os.tmpdir(), `update-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

const entry1: UpdateLogEntry = {
  timestamp: '2026-09-01T10:00:00.000Z',
  status: 'error',
  message: 'Cannot find latest.yml',
  currentVersion: '0.10.5',
  latestVersion: null,
};

const entry2: UpdateLogEntry = {
  timestamp: '2026-09-01T11:00:00.000Z',
  status: 'error',
  message: 'Network timeout',
  currentVersion: '0.10.5',
  latestVersion: null,
};

describe('updateLogger', () => {
  describe('writeUpdateLog', () => {
    it('creates the file and writes one JSON entry per line', () => {
      const file = tempFile();
      try {
        writeUpdateLog(file, entry1);
        const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toEqual(entry1);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it('appends to an existing file', () => {
      const file = tempFile();
      try {
        writeUpdateLog(file, entry1);
        writeUpdateLog(file, entry2);
        const entries = readUpdateLog(file);
        expect(entries).toHaveLength(2);
        expect(entries[0]).toEqual(entry1);
        expect(entries[1]).toEqual(entry2);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it('trims to the last 50 entries when over the cap', () => {
      const file = tempFile();
      try {
        for (let i = 0; i < 55; i++) {
          writeUpdateLog(file, { ...entry1, message: `error-${i}` });
        }
        const entries = readUpdateLog(file);
        expect(entries).toHaveLength(50);
        expect(entries[0].message).toBe('error-5');
        expect(entries[49].message).toBe('error-54');
      } finally {
        fs.rmSync(file, { force: true });
      }
    });
  });

  describe('readUpdateLog', () => {
    it('returns an empty array when the file does not exist', () => {
      expect(readUpdateLog(tempFile())).toEqual([]);
    });

    it('parses all entries from the file', () => {
      const file = tempFile();
      try {
        writeUpdateLog(file, entry1);
        writeUpdateLog(file, entry2);
        const result = readUpdateLog(file);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual(entry1);
        expect(result[1]).toEqual(entry2);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it('returns an empty array when the file is empty', () => {
      const file = tempFile();
      try {
        fs.writeFileSync(file, '');
        expect(readUpdateLog(file)).toEqual([]);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });
  });
});
