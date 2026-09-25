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
import type { TestSession, EmulationOverrides } from '../sessionManager';

function makeManager(): SessionManager {
  const win = { on: jest.fn() } as unknown as BrowserWindow;
  return new SessionManager(win, () => false);
}

// Installs a fake TestSession directly into the manager's private session
// map, bypassing the real createSession() (which needs a real
// WebContentsView) so setEmulation() can be exercised in isolation with a
// mock CDP debugger. `partition` defaults to the session's own id — good
// enough for tests that don't care about partition sharing; tests that do
// pass the same partition to two installed sessions explicitly.
function installFakeSession(sm: SessionManager, id: string, sendCommand: jest.Mock, partition = id) {
  const session = {
    id,
    partition,
    view: { webContents: { debugger: { sendCommand }, setUserAgent: jest.fn(), getUserAgent: jest.fn(() => 'real-ua') } },
    defaultUserAgent: 'real-ua',
  };
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session);
  return session;
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
  opts: { id: string; partition: string; persistent: boolean; emulation?: EmulationOverrides }
) {
  const session = {
    id: opts.id,
    name: opts.id,
    partition: opts.partition,
    persistent: opts.persistent,
    view: {
      webContents: {
        debugger: { sendCommand: jest.fn().mockResolvedValue({ identifier: 'x' }) },
        setUserAgent: jest.fn(),
        getUserAgent: jest.fn(() => 'real-ua'),
      },
    },
    defaultUserAgent: 'real-ua',
  };
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(opts.id, session);
  if (opts.emulation) {
    (sm as unknown as { emulationByPartition: Map<string, EmulationOverrides> })
      .emulationByPartition.set(opts.partition, opts.emulation);
  }
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

  it('a null timeOffsetMs clears just the offset, leaving other applied fields untouched (#241)', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({ identifier: 'script-5' });
    installFakeSession(sm, 's5', sendCommand);

    await sm.setEmulation('s5', { timeOffsetMs: 1000, timezone: 'Asia/Tokyo' });
    const errors = await sm.setEmulation('s5', { timeOffsetMs: null });

    expect(errors).toEqual({});
    expect(sm.getEmulation('s5')).toEqual({ timezone: 'Asia/Tokyo' });
  });

  it('a rejected Page.addScriptToEvaluateOnNewDocument reports an error and applies nothing (#241)', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockRejectedValue(new Error('boom'));
    installFakeSession(sm, 's6', sendCommand);

    const errors = await sm.setEmulation('s6', { timeOffsetMs: 5000 });

    expect(errors.timeOffsetMs).toBeTruthy();
    expect(sm.getEmulation('s6')).toEqual({});
  });
});

describe('setEmulation — timezone (#241)', () => {
  it('a rejected Emulation.setTimezoneOverride leaves the field as it was before the call', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn(async (cmd: string) => {
      if (cmd === 'Emulation.setTimezoneOverride') throw new Error('rejected');
      return {};
    });
    installFakeSession(sm, 'tz1', sendCommand);

    await sm.setEmulation('tz1', { locale: 'ja-JP' }); // some other field already applied
    const errors = await sm.setEmulation('tz1', { timezone: 'Asia/Tokyo' });

    expect(errors.timezone).toBe('rejected');
    expect(sm.getEmulation('tz1')).toEqual({ locale: 'ja-JP' }); // unchanged, not partially set
  });

  it('null clears the timezone override', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'tz2', sendCommand);

    await sm.setEmulation('tz2', { timezone: 'Asia/Tokyo', locale: 'ja-JP' });
    sendCommand.mockClear();
    const errors = await sm.setEmulation('tz2', { timezone: null });

    expect(errors).toEqual({});
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setTimezoneOverride', { timezoneId: '' });
    // The other field, not part of this patch, is left alone.
    expect(sm.getEmulation('tz2')).toEqual({ locale: 'ja-JP' });
  });
});

describe('setEmulation — geolocation clears as one combined field (#241)', () => {
  it('sets geolocation only once both latitude and longitude are real numbers', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'geo1', sendCommand);

    await sm.setEmulation('geo1', { latitude: 35.6762, longitude: 139.6503 });

    expect(sendCommand).toHaveBeenCalledWith('Emulation.setGeolocationOverride', { latitude: 35.6762, longitude: 139.6503, accuracy: 10 });
    expect(sm.getEmulation('geo1')).toEqual({ latitude: 35.6762, longitude: 139.6503 });
  });

  it('a lone coordinate (the other left null) clears geolocation entirely, not a partial set', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'geo2', sendCommand);

    await sm.setEmulation('geo2', { latitude: 35.6762, longitude: 139.6503 });
    sendCommand.mockClear();
    const errors = await sm.setEmulation('geo2', { latitude: null, longitude: null });

    expect(errors).toEqual({});
    expect(sendCommand).toHaveBeenCalledWith('Emulation.clearGeolocationOverride');
    expect(sm.getEmulation('geo2')).toEqual({});
  });

  it('a rejected clear leaves both coordinates as they were', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn(async (cmd: string) => {
      if (cmd === 'Emulation.clearGeolocationOverride') throw new Error('nope');
      return {};
    });
    installFakeSession(sm, 'geo3', sendCommand);

    await sm.setEmulation('geo3', { latitude: 1, longitude: 2 });
    const errors = await sm.setEmulation('geo3', { latitude: null, longitude: null });

    expect(errors.latitude).toBe('nope');
    expect(sm.getEmulation('geo3')).toEqual({ latitude: 1, longitude: 2 });
  });
});

describe('setEmulation — user-agent override (#163, #241)', () => {
  it('applies a UA override via webContents.setUserAgent and CDP, with derived Client Hints metadata', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'ua1', sendCommand);
    const s = (sm as unknown as { sessions: Map<string, { view: { webContents: { setUserAgent: jest.Mock } } } > }).sessions.get('ua1')!;

    const androidUa = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
    await sm.setEmulation('ua1', { userAgent: androidUa });

    expect(s.view.webContents.setUserAgent).toHaveBeenCalledWith(androidUa);
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
      userAgent: androidUa,
      userAgentMetadata: {
        brands: [{ brand: 'Chromium', version: '124' }, { brand: 'Google Chrome', version: '124' }],
        platform: 'Android',
        platformVersion: '',
        architecture: '',
        model: '',
        mobile: true,
      },
    });
    expect(sm.getEmulation('ua1')).toEqual({ userAgent: androidUa });
  });

  it('applying a null userAgent restores the captured default UA and clears the override', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'ua2', sendCommand);
    const s = (sm as unknown as { sessions: Map<string, { view: { webContents: { setUserAgent: jest.Mock } } } > }).sessions.get('ua2')!;

    await sm.setEmulation('ua2', { userAgent: 'spoofed-ua' });
    sendCommand.mockClear();
    (s.view.webContents.setUserAgent as jest.Mock).mockClear();

    await sm.setEmulation('ua2', { userAgent: null });

    expect(s.view.webContents.setUserAgent).toHaveBeenCalledWith('real-ua');
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
      userAgent: 'real-ua',
      userAgentMetadata: { brands: [], platform: '', platformVersion: '', architecture: '', model: '', mobile: false },
    });
    expect(sm.getEmulation('ua2')).toEqual({});
  });

  it('the clear path also restores the default UA', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'ua3', sendCommand);
    const s = (sm as unknown as { sessions: Map<string, { view: { webContents: { setUserAgent: jest.Mock } } } > }).sessions.get('ua3')!;

    await sm.setEmulation('ua3', { userAgent: 'spoofed-ua' });
    await sm.setEmulation('ua3', { clear: true });

    expect(s.view.webContents.setUserAgent).toHaveBeenCalledWith('real-ua');
    expect(sm.getEmulation('ua3')).toBeNull();
  });

  it('derives iOS platform metadata for an iPhone UA string with no Chrome token', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'ua4', sendCommand);

    const iosUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
    await sm.setEmulation('ua4', { userAgent: iosUa });

    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
      userAgent: iosUa,
      userAgentMetadata: {
        brands: [],
        platform: 'iOS',
        platformVersion: '',
        architecture: '',
        model: '',
        mobile: true,
      },
    });
  });

  it('a rejected Emulation.setUserAgentOverride reports an error and leaves the previous UA applied', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'ua5', sendCommand);

    await sm.setEmulation('ua5', { userAgent: 'first-ua' });
    sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd === 'Emulation.setUserAgentOverride') throw new Error('cdp down');
      return {};
    });
    const errors = await sm.setEmulation('ua5', { userAgent: 'second-ua' });

    expect(errors.userAgent).toBe('cdp down');
    expect(sm.getEmulation('ua5')).toEqual({ userAgent: 'first-ua' });
  });
});

describe('setEmulation — Accept-Language from locale (#241)', () => {
  it('acceptLanguage is included in the Network.setUserAgentOverride call when locale is set', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'loc1', sendCommand);

    await sm.setEmulation('loc1', { locale: 'fr-FR' });

    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', expect.objectContaining({
      acceptLanguage: 'fr-FR,fr',
    }));
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setLocaleOverride', { locale: 'fr-FR' });
    expect(sm.getEmulation('loc1')).toEqual({ locale: 'fr-FR' });
  });

  it('is issued with the current effective UA (default) when no explicit User-Agent override is active', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'loc2', sendCommand);

    await sm.setEmulation('loc2', { locale: 'de-DE' });

    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', expect.objectContaining({
      userAgent: 'real-ua',
      acceptLanguage: 'de-DE,de',
    }));
  });

  it('carries a previously-set UA override alongside the new acceptLanguage, without clobbering it', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'loc3', sendCommand);

    await sm.setEmulation('loc3', { userAgent: 'spoofed-ua' });
    sendCommand.mockClear();
    await sm.setEmulation('loc3', { locale: 'ja-JP' });

    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', expect.objectContaining({
      userAgent: 'spoofed-ua',
      acceptLanguage: 'ja-JP,ja',
    }));
    expect(sm.getEmulation('loc3')).toEqual({ userAgent: 'spoofed-ua', locale: 'ja-JP' });
  });
});

describe('setEmulation — partition sharing (#241)', () => {
  it('two tabs sharing one partition see the same emulation overrides, without calling setEmulation for the second', async () => {
    const sm = makeManager();
    const sendCommandA = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'tab-a', sendCommandA, 'persist:shared-emu');

    await sm.setEmulation('tab-a', { timezone: 'Asia/Tokyo', locale: 'ja-JP' });

    const sendCommandB = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'tab-b', sendCommandB, 'persist:shared-emu');

    expect(sm.getEmulation('tab-b')).toEqual(sm.getEmulation('tab-a'));
    expect(sendCommandB).not.toHaveBeenCalled();
  });

  it('two tabs on genuinely different partitions never see each other\'s overrides', async () => {
    const sm = makeManager();
    const sendCommandA = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'tab-c', sendCommandA, 'persist:one');
    const sendCommandB = jest.fn().mockResolvedValue({});
    installFakeSession(sm, 'tab-d', sendCommandB, 'persist:two');

    await sm.setEmulation('tab-c', { timezone: 'Asia/Tokyo' });

    expect(sm.getEmulation('tab-d')).toBeNull();
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

    const setEmulationSpy = jest.spyOn(sm, 'setEmulation').mockResolvedValue({});
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

    const setEmulationSpy = jest.spyOn(sm, 'setEmulation').mockResolvedValue({});
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
      } as unknown as TestSession;
      (sm as unknown as { sessions: Map<string, TestSession> }).sessions.set(session.id, session);
      return session;
    });

    sm.loadAndRestoreSessions();

    expect(setEmulationSpy).not.toHaveBeenCalled();
  });
});
