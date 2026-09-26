import type { BrowserWindow } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Same minimal mocks as sessionPinPersistence.test.ts — createSession()/
// saveSessions()/loadAndRestoreSessions() need a real-enough WebContentsView,
// session and debugger surface to run end to end.
jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    pragma: jest.fn(),
    exec: jest.fn(),
    prepare: jest.fn(() => ({ run: jest.fn(), get: jest.fn(), all: jest.fn(() => []) })),
    close: jest.fn(),
  }));
});

let userDataDir: string;

jest.mock('electron', () => {
  const { EventEmitter } = require('events');

  class FakeWebContents extends EventEmitter {
    id = Math.floor(Math.random() * 1e6);
    debugger: any;
    constructor() {
      super();
      this.debugger = new EventEmitter();
      this.debugger.sendCommand = jest.fn().mockResolvedValue({});
    }
    getUserAgent() { return 'fake-ua'; }
    setUserAgent() {}
    setWindowOpenHandler() {}
    loadFile() {}
    loadURL() {}
    canGoBack() { return false; }
    canGoForward() { return false; }
    getZoomFactor() { return 1; }
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents();
    setBounds() {}
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app: { getPath: jest.fn(() => (global as any).__tbUserDataDir) },
    BrowserWindow: class {},
    WebContentsView: FakeWebContentsView,
    session: {
      fromPartition: jest.fn(() => {
        const ses = new EventEmitter();
        (ses as any).webRequest = { onCompleted: jest.fn() };
        (ses as any).setPermissionRequestHandler = jest.fn();
        (ses as any).setPermissionCheckHandler = jest.fn();
        (ses as any).cookies = { get: jest.fn().mockResolvedValue([]) };
        return ses;
      }),
    },
    Menu: { buildFromTemplate: jest.fn(() => ({ popup: jest.fn() })) },
    clipboard: { writeText: jest.fn() },
    dialog: {},
  };
});

import { SessionManager } from '../sessionManager';

function makeManager(): SessionManager {
  const win = {
    on: jest.fn(),
    contentView: { addChildView: jest.fn(), removeChildView: jest.fn() },
    webContents: { send: jest.fn() },
    getContentBounds: jest.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
  } as unknown as BrowserWindow;
  return new SessionManager(win, () => false);
}

function sessionsFilePath(): string {
  return path.join(userDataDir, 'open-sessions.json');
}

describe('Session notes persistence (#268)', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-notes-persist-'));
    (global as any).__tbUserDataDir = userDataDir;
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('two persistent tabs sharing a partition keep independent notes across a save/restore round-trip', () => {
    const sm1 = makeManager();
    const a = sm1.createSession('Tab A', { persistent: true });
    const b = sm1.createSession('Tab B', { persistent: true, partition: a.partition });
    expect(b.partition).toBe(a.partition); // sharing a partition is the whole point of this test

    sm1.setNotes(a.id, 'note for A');
    sm1.setNotes(b.id, 'note for B');
    sm1.saveSessions();

    const onDisk = JSON.parse(fs.readFileSync(sessionsFilePath(), 'utf-8'));
    // Keyed by (the now-persisted) session id, not partition — a and b would
    // collide on a single key under the old partition-keyed shape.
    expect(onDisk.notes[a.id]).toBe('note for A');
    expect(onDisk.notes[b.id]).toBe('note for B');

    const sm2 = makeManager();
    expect(sm2.loadAndRestoreSessions()).toBe(true);
    const [restoredA, restoredB] = sm2.listSessions();
    expect(sm2.getNotes(restoredA.id)).toBe('note for A');
    expect(sm2.getNotes(restoredB.id)).toBe('note for B');
  });

  it('a session id is stable across save/restore, so a second restart still finds the right note', () => {
    const sm1 = makeManager();
    const a = sm1.createSession('Tab A', { persistent: true });
    sm1.setNotes(a.id, 'first note');
    sm1.saveSessions();

    const sm2 = makeManager();
    sm2.loadAndRestoreSessions();
    const [restored1] = sm2.listSessions();
    expect(restored1.id).toBe(a.id); // id survives the round-trip unchanged
    sm2.setNotes(restored1.id, 'updated note');
    sm2.saveSessions();

    const sm3 = makeManager();
    sm3.loadAndRestoreSessions();
    const [restored2] = sm3.listSessions();
    expect(sm3.getNotes(restored2.id)).toBe('updated note');
  });

  it('migrates a legacy partition-keyed notes file onto the first restored session of that partition', () => {
    // Simulate a file written before #268: no `id` on session entries, and
    // `notes` keyed by partition.
    userDataDirWrite({
      sessions: [
        { name: 'Tab A', partition: 'persist:shared', url: '', color: '#fff', pinned: false },
        { name: 'Tab B', partition: 'persist:shared', url: '', color: '#fff', pinned: false },
      ],
      notes: { 'persist:shared': 'legacy shared note' },
      emulation: {},
    });

    const sm = makeManager();
    expect(sm.loadAndRestoreSessions()).toBe(true);
    const [restoredA, restoredB] = sm.listSessions();
    // Applied once, to the first restored session of that partition — the
    // second tab on the same partition gets nothing, since the legacy file
    // never recorded which of the two it actually belonged to.
    expect(sm.getNotes(restoredA.id)).toBe('legacy shared note');
    expect(sm.getNotes(restoredB.id)).toBe('');
  });

  it('a legacy file converges to id-keyed notes after one save, and a second restore no longer needs migration', () => {
    userDataDirWrite({
      sessions: [{ name: 'Tab A', partition: 'persist:solo', url: '', color: '#fff', pinned: false }],
      notes: { 'persist:solo': 'legacy note' },
      emulation: {},
    });

    const sm1 = makeManager();
    sm1.loadAndRestoreSessions();
    const [migrated] = sm1.listSessions();
    sm1.saveSessions();

    const onDisk = JSON.parse(fs.readFileSync(sessionsFilePath(), 'utf-8'));
    expect(onDisk.notes).toEqual({ [migrated.id]: 'legacy note' });
    expect(onDisk.sessions[0].id).toBe(migrated.id);

    const sm2 = makeManager();
    sm2.loadAndRestoreSessions();
    const [restored] = sm2.listSessions();
    expect(restored.id).toBe(migrated.id); // id is now stable — no more migration needed
    expect(sm2.getNotes(restored.id)).toBe('legacy note');
  });

  it('drops notes for a session that is no longer live by the next save', () => {
    const sm = makeManager();
    const a = sm.createSession('Tab A', { persistent: true });
    const b = sm.createSession('Tab B', { persistent: true });
    sm.setNotes(a.id, 'keep me');
    sm.setNotes(b.id, 'goodbye');
    sm.destroySession(b.id);
    sm.saveSessions();

    const onDisk = JSON.parse(fs.readFileSync(sessionsFilePath(), 'utf-8'));
    expect(onDisk.notes).toEqual({ [a.id]: 'keep me' });
  });

  it('does not persist notes for a non-persistent (in-memory) session', () => {
    const sm = makeManager();
    const temp = sm.createSession('Temp', { persistent: false });
    sm.setNotes(temp.id, 'ephemeral note');
    sm.saveSessions();

    const onDisk = JSON.parse(fs.readFileSync(sessionsFilePath(), 'utf-8'));
    expect(onDisk.notes).toEqual({});
    expect(onDisk.sessions).toEqual([]); // nothing to restore either — it was never a saved tab
  });

  function userDataDirWrite(content: unknown) {
    fs.writeFileSync(sessionsFilePath(), JSON.stringify(content));
  }
});
