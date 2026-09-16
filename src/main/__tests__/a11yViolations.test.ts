import axeCore from 'axe-core';
import { A11Y_VIOLATIONS_EXCLUDED_RULES, buildAxeRuleConfig } from '../sessionManager';

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
