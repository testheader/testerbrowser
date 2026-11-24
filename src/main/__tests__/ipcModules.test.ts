// #283: the IPC split moved all 154 ipcMain.handle registrations out of
// index.ts into src/main/ipc/*.ts feature modules, each exporting a plain
// register(deps) function. That relocation has no compile-time signal if a
// channel name gets mistyped or a handler stops delegating correctly, so
// these tests register a handful of representative modules against a fake
// ipcMain (capturing channel -> handler) and fake AppDeps, then invoke the
// handlers directly — proving register() actually wires the channel name to
// a handler that calls through to the right SessionManager method, and that
// the null-sessionManager fallback (window not ready yet) doesn't throw.

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, fn);
    },
  },
}));

import { registerRulesIpc } from '../ipc/rules';
import { registerThrottleIpc } from '../ipc/throttle';
import { registerEmulationIpc } from '../ipc/emulation';
import { registerPermissionsIpc } from '../ipc/permissions';
import type { AppDeps } from '../ipc/deps';
import type { SessionManager } from '../sessionManager';

function fakeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    getWin: () => null,
    getSessionManager: () => null,
    getVisualRegressionStore: () => null,
    getFocusedWin: () => null,
    openWindow: jest.fn(),
    broadcast: jest.fn(),
    getDebugLogStore: () => null,
    getLogsDir: () => '/tmp',
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as unknown as AppDeps['log'],
    recordAppError: jest.fn(),
    persistSessionUrls: jest.fn(),
    ...overrides,
  };
}

function call(channel: string, ...args: unknown[]): unknown {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({} as never, ...args);
}

beforeEach(() => {
  registeredHandlers.clear();
});

describe('registerRulesIpc (#283, #370)', () => {
  it('registers every rules:* channel', () => {
    registerRulesIpc(fakeDeps());
    expect([...registeredHandlers.keys()]).toEqual([
      'rules:getRules', 'rules:addRule', 'rules:removeRule', 'rules:toggleRule',
      'rules:updateRule', 'rules:moveRule', 'rules:reorderRule', 'rules:exportRules', 'rules:importRules',
    ]);
  });

  it('rules:getRules delegates to sessionManager.getRules(id)', () => {
    const getRules = jest.fn(() => [{ id: 'r1' }]);
    registerRulesIpc(fakeDeps({ getSessionManager: () => ({ getRules } as unknown as SessionManager) }));
    expect(call('rules:getRules', 's1')).toEqual([{ id: 'r1' }]);
    expect(getRules).toHaveBeenCalledWith('s1');
  });

  it('rules:reorderRule passes the target index through', () => {
    const reorderRule = jest.fn();
    registerRulesIpc(fakeDeps({ getSessionManager: () => ({ reorderRule } as unknown as SessionManager) }));
    call('rules:reorderRule', 's1', 'r1', 0);
    expect(reorderRule).toHaveBeenCalledWith('s1', 'r1', 0);
  });

  it('rules:getRules falls back to [] when the window/sessionManager is not ready yet', () => {
    registerRulesIpc(fakeDeps({ getSessionManager: () => null }));
    expect(call('rules:getRules', 's1')).toEqual([]);
  });

  it('rules:updateRule falls back to false, and export to an error result (not a throw), with no sessionManager', () => {
    registerRulesIpc(fakeDeps({ getSessionManager: () => null }));
    expect(call('rules:updateRule', 's1', 'r1', {})).toBe(false);
    expect(call('rules:exportRules', 's1')).toEqual({ ok: false, error: 'No session manager' });
  });
});

describe('registerThrottleIpc (#283)', () => {
  it('registers the throttling channels', () => {
    registerThrottleIpc(fakeDeps());
    expect([...registeredHandlers.keys()]).toEqual(['resilience:setConditions', 'resilience:getConditions']);
  });

  it('resilience:setConditions passes both id and conditions through to sessionManager.setConditions', () => {
    const setConditions = jest.fn();
    registerThrottleIpc(fakeDeps({ getSessionManager: () => ({ setConditions } as unknown as SessionManager) }));
    const conditions = { network: 'offline', cpuRate: 4 };
    call('resilience:setConditions', 's1', conditions);
    expect(setConditions).toHaveBeenCalledWith('s1', conditions);
  });

  it('resilience:getConditions falls back to null with no sessionManager', () => {
    registerThrottleIpc(fakeDeps({ getSessionManager: () => null }));
    expect(call('resilience:getConditions', 's1')).toBeNull();
  });
});

describe('registerEmulationIpc (#283)', () => {
  it('registers session:setEmulation and session:getEmulation', () => {
    registerEmulationIpc(fakeDeps());
    expect([...registeredHandlers.keys()]).toEqual(['session:setEmulation', 'session:getEmulation']);
  });

  it('session:setEmulation delegates to sessionManager.setEmulation(id, opts)', () => {
    const setEmulation = jest.fn(() => ({ ok: true }));
    registerEmulationIpc(fakeDeps({ getSessionManager: () => ({ setEmulation } as unknown as SessionManager) }));
    const opts = { timezone: 'UTC' };
    expect(call('session:setEmulation', 's1', opts)).toEqual({ ok: true });
    expect(setEmulation).toHaveBeenCalledWith('s1', opts);
  });
});

describe('registerPermissionsIpc (#283)', () => {
  it('registers every permission:* channel', () => {
    registerPermissionsIpc(fakeDeps());
    expect([...registeredHandlers.keys()]).toEqual(['permission:respond', 'permission:list', 'permission:revoke']);
  });

  it('permission:revoke delegates (id, origin, permission) to sessionManager.revokePermission', () => {
    const revokePermission = jest.fn(() => true);
    registerPermissionsIpc(fakeDeps({ getSessionManager: () => ({ revokePermission } as unknown as SessionManager) }));
    expect(call('permission:revoke', 's1', 'https://example.com', 'geolocation')).toBe(true);
    expect(revokePermission).toHaveBeenCalledWith('s1', 'https://example.com', 'geolocation');
  });

  it('permission:revoke falls back to false with no sessionManager, rather than throwing', () => {
    registerPermissionsIpc(fakeDeps({ getSessionManager: () => null }));
    expect(call('permission:revoke', 's1', 'https://example.com', 'geolocation')).toBe(false);
  });
});
