import type { BrowserWindow } from 'electron';

// SessionManager's constructor only touches `app.getPath` from electron at
// construction time (via dbDir); every other electron import it uses (Menu,
// dialog, WebContentsView, session, clipboard) is only referenced inside
// methods this test never calls.
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/tb-fake-userdata') },
}));

import { SessionManager } from '../sessionManager';

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
