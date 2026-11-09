import type { BrowserWindow } from 'electron';

// better-sqlite3 is compiled against Electron's ABI, incompatible with Jest's Node
// runtime (see recorder.test.ts) — mocked minimally; only SessionRecorder's
// constructor needs to not throw.
jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    pragma: jest.fn(),
    exec: jest.fn(),
    prepare: jest.fn(() => ({ run: jest.fn(), get: jest.fn(), all: jest.fn(() => []) })),
    close: jest.fn(),
  }));
});

// createSession() registers setWindowOpenHandler()'s callback, so it has to really
// run here; the fake captures the handler so a test can invoke it with each disposition.
type OpenDetails = { url: string; disposition?: string };
let capturedHandler: ((details: OpenDetails) => unknown) | undefined;

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
    setWindowOpenHandler(handler: (details: OpenDetails) => unknown) { capturedHandler = handler; }
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
    app: { getPath: jest.fn(() => '/tmp/tb-window-open-routing-test') },
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

// The tab (deny) path's setImmediate() callback calls switchTo() and sends to the
// chrome window, so those need mocking or it throws asynchronously and takes down Jest.
function makeManager(): SessionManager {
  const win = {
    on: jest.fn(),
    contentView: { addChildView: jest.fn(), removeChildView: jest.fn() },
    getContentBounds: jest.fn(() => ({ width: 800, height: 600 })),
    webContents: { send: jest.fn() },
  } as unknown as BrowserWindow;
  return new SessionManager(win, () => false);
}

describe('setWindowOpenHandler routing (#367)', () => {
  beforeEach(() => { capturedHandler = undefined; });

  it.each(['foreground-tab', 'background-tab'])('%s opens a tab: deny and recreate in this window', (disposition) => {
    const sm = makeManager();
    sm.createPopupWindow = jest.fn();
    sm.createSession('Test');
    expect(capturedHandler!({ url: 'https://example.com/a', disposition })).toEqual({ action: 'deny' });
    expect(sm.createPopupWindow).not.toHaveBeenCalled();
  });

  it('new-window (a features string) opens a full window via createWindow, in the opener\'s partition and colour', () => {
    const sm = makeManager();
    const popupWebContents = {};
    const createPopupWindow = jest.fn(() => popupWebContents);
    sm.createPopupWindow = createPopupWindow as never;
    const opener = sm.createSession('Test');

    const response = capturedHandler!({ url: 'https://example.com/oauth', disposition: 'new-window' }) as {
      action: string; createWindow?: (o: unknown) => unknown;
    };
    expect(response.action).toBe('allow');
    expect(createPopupWindow).not.toHaveBeenCalled(); // only when Electron asks for the window
    expect(response.createWindow!({})).toBe(popupWebContents);
    expect(createPopupWindow).toHaveBeenCalledWith({ name: 'example.com', partition: opener.partition, color: opener.color });
  });

  it('falls back to a tab when no window factory is wired up', () => {
    const sm = makeManager();
    sm.createSession('Test');
    expect(capturedHandler!({ url: 'https://example.com/a', disposition: 'new-window' })).toEqual({ action: 'deny' });
  });

  it('denies an unsafe URL on every path', () => {
    const sm = makeManager();
    sm.createPopupWindow = jest.fn();
    sm.createSession('Test');
    for (const disposition of ['foreground-tab', 'new-window']) {
      expect(capturedHandler!({ url: 'javascript:alert(1)', disposition })).toEqual({ action: 'deny' });
      expect(capturedHandler!({ url: 'file:///etc/passwd', disposition })).toEqual({ action: 'deny' });
    }
    expect(sm.createPopupWindow).not.toHaveBeenCalled();
  });
});
