import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';
import axeCore from 'axe-core';

// SessionManager's constructor only touches `app.getPath` from electron at
// construction time (via dbDir); every other electron import it uses is only
// referenced inside methods this file never calls (same rationale as
// emulation.test.ts, which this file's SessionManager-instantiation helpers
// below are modeled on).
const mockUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-a11y-violations-test-'));
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => mockUserDataDir) },
}));

import { A11Y_VIOLATIONS_EXCLUDED_RULES, buildAxeRuleConfig, SessionManager } from '../sessionManager';

describe('buildAxeRuleConfig (#193 — axe-core violations audit)', () => {
  it('disables every rule owned by a sibling A11y tab ticket', () => {
    const config = buildAxeRuleConfig();
    for (const id of A11Y_VIOLATIONS_EXCLUDED_RULES) {
      expect(config[id]).toEqual({ enabled: false });
    }
  });

  it('excludes color-contrast (#194) and image-alt/label (#196)', () => {
    const config = buildAxeRuleConfig();
    expect(config['color-contrast']).toEqual({ enabled: false });
    expect(config['image-alt']).toEqual({ enabled: false });
    expect(config['label']).toEqual({ enabled: false });
  });

  it('excludes the full heading-order/landmark-*/region family (#195)', () => {
    const config = buildAxeRuleConfig();
    expect(config['heading-order']).toEqual({ enabled: false });
    expect(config['region']).toEqual({ enabled: false });
    const landmarkIds = A11Y_VIOLATIONS_EXCLUDED_RULES.filter(id => id.startsWith('landmark-'));
    expect(landmarkIds.length).toBeGreaterThan(0);
    for (const id of landmarkIds) expect(config[id]).toEqual({ enabled: false });
  });

  // The landmark rule set in particular has grown across axe-core releases
  // (per the ticket) — this guards against the excluded-rule list silently
  // drifting from what a future axe-core upgrade actually ships.
  it('every excluded rule id is a real rule in the installed axe-core version', () => {
    const knownIds = new Set(axeCore.getRules().map(r => r.ruleId));
    for (const id of A11Y_VIOLATIONS_EXCLUDED_RULES) {
      expect(knownIds.has(id)).toBe(true);
    }
  });

  it('does not exclude unrelated rules', () => {
    const config = buildAxeRuleConfig();
    expect(config['duplicate-id']).toBeUndefined();
    expect(config['aria-roles']).toBeUndefined();
  });
});

// ── getA11yViolations (#222 — a failed audit must never look like a clean pass) ──

function makeManager(): SessionManager {
  const win = { on: jest.fn() } as unknown as BrowserWindow;
  return new SessionManager(win, () => false);
}

// Bypasses createSession() (needs a real WebContentsView) so
// getA11yViolations() can be exercised in isolation with a mock CDP
// debugger, same technique as emulation.test.ts's installFakeSession().
function installFakeSession(sm: SessionManager, id: string, sendCommand: jest.Mock) {
  const session = { id, view: { webContents: { debugger: { sendCommand } } } };
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session);
}

// Forces getAxeSource()'s cache directly rather than mocking fs — its guard
// is `if (this.axeSource === null)`, so pre-seeding the private field skips
// the real file read entirely and deterministically simulates either
// outcome.
function setFakeAxeSource(sm: SessionManager, value: string) {
  (sm as unknown as { axeSource: string | null }).axeSource = value;
}

describe('getA11yViolations', () => {
  it('returns ok:false without calling the debugger for an unknown session', async () => {
    const sm = makeManager();
    const result = await sm.getA11yViolations('no-such-session');
    expect(result).toEqual({ ok: false, error: expect.any(String) });
  });

  it('returns ok:false when the axe-core bundle could not be loaded', async () => {
    const sm = makeManager();
    const sendCommand = jest.fn();
    installFakeSession(sm, 's1', sendCommand);
    setFakeAxeSource(sm, ''); // simulates getAxeSource()'s own read-failure fallback

    const result = await sm.getA11yViolations('s1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/axe/i);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('returns ok:false with the exception description when Runtime.evaluate reports exceptionDetails', async () => {
    const sm = makeManager();
    setFakeAxeSource(sm, '/* fake axe source */');
    const sendCommand = jest.fn()
      .mockResolvedValueOnce({}) // injecting the axe source itself
      .mockResolvedValueOnce({
        exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: axe is not defined' } },
      });
    installFakeSession(sm, 's1', sendCommand);

    const result = await sm.getA11yViolations('s1');
    expect(result).toEqual({ ok: false, error: 'ReferenceError: axe is not defined' });
  });

  it('falls back to exceptionDetails.text when there is no exception.description', async () => {
    const sm = makeManager();
    setFakeAxeSource(sm, '/* fake axe source */');
    const sendCommand = jest.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ exceptionDetails: { text: 'Script error' } });
    installFakeSession(sm, 's1', sendCommand);

    const result = await sm.getA11yViolations('s1');
    expect(result).toEqual({ ok: false, error: 'Script error' });
  });

  it('returns ok:false when the evaluate result is not a string (e.g. no result at all)', async () => {
    const sm = makeManager();
    setFakeAxeSource(sm, '/* fake axe source */');
    const sendCommand = jest.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ result: {} });
    installFakeSession(sm, 's1', sendCommand);

    const result = await sm.getA11yViolations('s1');
    expect(result.ok).toBe(false);
  });

  it('returns ok:false when the debugger throws', async () => {
    const sm = makeManager();
    setFakeAxeSource(sm, '/* fake axe source */');
    const sendCommand = jest.fn().mockRejectedValue(new Error('debugger detached'));
    installFakeSession(sm, 's1', sendCommand);

    const result = await sm.getA11yViolations('s1');
    expect(result).toEqual({ ok: false, error: 'debugger detached' });
  });

  it('returns ok:true with the parsed violations on a valid JSON result', async () => {
    const sm = makeManager();
    setFakeAxeSource(sm, '/* fake axe source */');
    const violations = [{ id: 'color-contrast', impact: 'serious', nodes: [] }];
    const sendCommand = jest.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ result: { value: JSON.stringify(violations) } });
    installFakeSession(sm, 's1', sendCommand);

    const result = await sm.getA11yViolations('s1');
    expect(result).toEqual({ ok: true, violations });
  });

  it('returns ok:true with an empty array for a genuinely clean page', async () => {
    const sm = makeManager();
    setFakeAxeSource(sm, '/* fake axe source */');
    const sendCommand = jest.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ result: { value: '[]' } });
    installFakeSession(sm, 's1', sendCommand);

    const result = await sm.getA11yViolations('s1');
    expect(result).toEqual({ ok: true, violations: [] });
  });
});
