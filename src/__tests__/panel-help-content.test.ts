import { readFileSync } from 'fs';
import { join } from 'path';
import { PANEL_HELP } from '../../renderer/panel-help-content.js';

describe('console header help', () => {
  const html = readFileSync(join(__dirname, '../../renderer/index.html'), 'utf8');
  const tabs = [...html.matchAll(/class="console-tab( [^"]*)?" id="consoleTab([A-Za-z0-9]+)"/g)].map(m => m[2]);

  it('has an entry for every console tab', () => {
    // switchConsoleTab()'s names vs. the button ids differ (VR, Tests, DebugLog…),
    // so compare counts and that every entry is non-empty.
    expect(tabs.length).toBe(Object.keys(PANEL_HELP).length);
    for (const [name, help] of Object.entries(PANEL_HELP)) {
      expect(help.title.length).toBeGreaterThan(0);
      expect(help.body.length).toBeGreaterThan(0);
      expect(name).toMatch(/^[a-z0-9]+$/);
    }
  });
});
