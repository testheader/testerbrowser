import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';

// A real temp directory so saveSessions()/loadAndRestoreSessions() can
// genuinely read/write open-sessions.json, exercising the persistence
// round-trip rather than mocking fs itself. `mock`-prefixed so Jest's
// hoisting of jest.mock() above this file's imports can still reference it.
const mockUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-emulation-test-'));

// SessionManager's constructor only touches `app.getPath` from electron at
// construction time (via dbDir); every other electron import it uses (Menu,
// dialog, WebContentsView, session, clipboard) is only referenced inside
// methods this test never calls.
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => mockUserDataDir) },
}));

import { SessionManager } from '../sessionManager';
import type { TestSession } from '../sessionManager';

function makeManager(): SessionManager {
  const win = { on: jest.fn() } as unknown as BrowserWindow;
  return new SessionManager(win, () => false);
}

// Installs a fake TestSession directly into the manager's private session
// map, bypassing the real createSession() (which needs a real
// WebContentsView) so setEmulation() can be exercised in isolation with a
// mock CDP debugger.
function installFakeSession(sm: SessionManager, id: string, sendCommand: jest.Mock) {
  const session = {
    id,
    view: { webContents: { debugger: { sendCommand } } },
    emulation: null,
  };
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session);
}

// Fuller "win" mock for tests that exercise loadAndRestoreSessions(), which
// calls switchTo() on the restored session — unlike installFakeSession()
// above (used only for setEmulation(), which never touches `win`).
function makeManagerWithWin(): SessionManager {
  const win = {
    on: jest.fn(),
    contentView: { addChildView: jest.fn(), removeChildView: jest.fn() },
    getContentBounds: jest.fn(() => ({ width: 800, height: 600 })),
    webContents: { send: jest.fn() },
  } as unknown as BrowserWindow;
  return new SessionManager(win, () => false);
}

function installFakeSessionFull(
  sm: SessionManager,
  opts: { id: string; partition: string; persistent: boolean; emulation?: unknown }
) {
  const session = {
    id: opts.id,
    name: opts.id,
    partition: opts.partition,
    persistent: opts.persistent,
    view: { webContents: { debugger: { sendCommand: jest.fn().mockResolvedValue({ identifier: 'x' }) } } },
    emulation: opts.emulation ?? null,
  };
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(opts.id, session);
}

describe('setEmulation — signed clock offset', () => {
  it('passes a positive offset through unchanged as timeOffsetMs', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({ identifier: 'script-1' });
    installFakeSession(sm, 's1', sendCommand);

    await sm.setEmulation('s1', { timeOffsetMs: 86400000 });

    expect(sm.getEmulation('s1')).toEqual({ timeOffsetMs: 86400000 });
    expect(sendCommand).toHaveBeenCalledWith(
      'Page.addScriptToEvaluateOnNewDocument',
      expect.objectContaining({ source: expect.stringContaining('86400000') })
    );
  });

  it('preserves a negative offset', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({ identifier: 'script-2' });
    installFakeSession(sm, 's2', sendCommand);

    await sm.setEmulation('s2', { timeOffsetMs: -3600000 });

    expect(sm.getEmulation('s2')).toEqual({ timeOffsetMs: -3600000 });
    expect(sendCommand).toHaveBeenCalledWith(
      'Page.addScriptToEvaluateOnNewDocument',
      expect.objectContaining({ source: expect.stringContaining('-3600000') })
    );
  });

  it('the clear path removes the previously injected script and clears state', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({ identifier: 'script-3' });
    installFakeSession(sm, 's3', sendCommand);

    await sm.setEmulation('s3', { timeOffsetMs: 604800000 });
    sendCommand.mockClear();

    await sm.setEmulation('s3', { clear: true });

    expect(sendCommand).toHaveBeenCalledWith('Page.removeScriptToEvaluateOnNewDocument', { identifier: 'script-3' });
    expect(sm.getEmulation('s3')).toBeNull();
  });

  it('re-applying a changed offset removes the old script before injecting the new one', async () => {
    const sm = makeManager();
    let addScriptCalls = 0;
    const sendCommand = jest.fn(async (cmd: string) => {
      if (cmd === 'Page.addScriptToEvaluateOnNewDocument') {
        addScriptCalls += 1;
        return { identifier: addScriptCalls === 1 ? 'script-4a' : 'script-4b' };
      }
      return {};
    });
    installFakeSession(sm, 's4', sendCommand);

    await sm.setEmulation('s4', { timeOffsetMs: 1000 });
    await sm.setEmulation('s4', { timeOffsetMs: 2000 });

    expect(sendCommand).toHaveBeenCalledWith('Page.removeScriptToEvaluateOnNewDocument', { identifier: 'script-4a' });
    expect(sm.getEmulation('s4')).toEqual({ timeOffsetMs: 2000 });
  });
});

describe('persisting and restoring spoof overrides across sessions (#161)', () => {
  it('saveSessions() writes emulation for persistent sessions and omits it for temporary ones', () => {
    const sm = makeManager();
    installFakeSessionFull(sm, {
      id: 'persist-1', partition: 'persist:a', persistent: true,
      emulation: { timezone: 'Asia/Tokyo', timeOffsetMs: 86400000 },
    });
    installFakeSessionFull(sm, {
      id: 'temp-1', partition: 'temp:b', persistent: false,
      emulation: { timezone: 'Europe/Paris' },
    });

    sm.saveSessions();

    const sessionsFile = (sm as unknown as { sessionsFile: string }).sessionsFile;
    const written = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    expect(written.emulation).toEqual({ 'persist:a': { timezone: 'Asia/Tokyo', timeOffsetMs: 86400000 } });
    expect(written.sessions).toHaveLength(1);
    expect(written.sessions[0].partition).toBe('persist:a');
  });

  it('saveSessions() omits the emulation key for a persistent session with no overrides applied', () => {
    const sm = makeManager();
    installFakeSessionFull(sm, { id: 'persist-2', partition: 'persist:c', persistent: true });

    sm.saveSessions();

    const sessionsFile = (sm as unknown as { sessionsFile: string }).sessionsFile;
    const written = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    expect(written.emulation).toEqual({});
  });

  it('loadAndRestoreSessions() re-applies persisted overrides through setEmulation, not just s.emulation', () => {
    const sm = makeManagerWithWin();
    const overrides = { timezone: 'Asia/Tokyo', locale: 'ja-JP', timeOffsetMs: -3600000 };

    const sessionsFile = (sm as unknown as { sessionsFile: string }).sessionsFile;
    fs.writeFileSync(sessionsFile, JSON.stringify({
      sessions: [{ name: 'Restored', partition: 'persist:restore-1', url: '', color: '#fff' }],
      notes: {},
      emulation: { 'persist:restore-1': overrides },
    }));

    const setEmulationSpy = jest.spyOn(sm, 'setEmulation').mockResolvedValue();
    jest.spyOn(sm, 'createSession').mockImplementation((name: string, opts?: { partition?: string }) => {
      const session = {
        id: 'restored-id',
        name,
        partition: opts?.partition ?? '',
        persistent: true,
        view: {
          webContents: {
            debugger: { sendCommand: jest.fn().mockResolvedValue({}) },
            getZoomFactor: jest.fn(() => 1),
            canGoBack: jest.fn(() => false),
            canGoForward: jest.fn(() => false),
          },
          setBounds: jest.fn(),
        },
        emulation: null,
      } as unknown as TestSession;
      (sm as unknown as { sessions: Map<string, TestSession> }).sessions.set(session.id, session);
      return session;
    });

    const ok = sm.loadAndRestoreSessions();

    expect(ok).toBe(true);
    expect(setEmulationSpy).toHaveBeenCalledWith('restored-id', overrides);
  });

  it("loadAndRestoreSessions() does not call setEmulation for a restored session with no stored overrides", () => {
    const sm = makeManagerWithWin();

    const sessionsFile = (sm as unknown as { sessionsFile: string }).sessionsFile;
    fs.writeFileSync(sessionsFile, JSON.stringify({
      sessions: [{ name: 'Plain', partition: 'persist:plain-1', url: '', color: '#fff' }],
      notes: {},
      emulation: {},
    }));

    const setEmulationSpy = jest.spyOn(sm, 'setEmulation').mockResolvedValue();
    jest.spyOn(sm, 'createSession').mockImplementation((name: string, opts?: { partition?: string }) => {
      const session = {
        id: 'plain-id',
        name,
        partition: opts?.partition ?? '',
        persistent: true,
        view: {
          webContents: {
            debugger: { sendCommand: jest.fn().mockResolvedValue({}) },
            getZoomFactor: jest.fn(() => 1),
            canGoBack: jest.fn(() => false),
            canGoForward: jest.fn(() => false),
          },
          setBounds: jest.fn(),
        },
        emulation: null,
      } as unknown as TestSession;
      (sm as unknown as { sessions: Map<string, TestSession> }).sessions.set(session.id, session);
      return session;
    });

    sm.loadAndRestoreSessions();

    expect(setEmulationSpy).not.toHaveBeenCalled();
  });
});
