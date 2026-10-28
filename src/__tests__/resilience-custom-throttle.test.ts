import fs from 'fs';
import path from 'path';

const renderer = path.join(__dirname, '..', '..', 'renderer');
const resilience = fs.readFileSync(path.join(renderer, 'resilience.js'), 'utf8');
const emulation = fs.readFileSync(path.join(renderer, 'emulation.js'), 'utf8');

// #330: Latency / Download / Upload only show when the network preset is "Custom".
// #341: the throttling controls live in Spoof › Advanced, not Resilience.
describe('custom throttle fields', () => {
  it('start hidden in the Spoof markup', () => {
    expect(emulation).toMatch(/spoof-throttle-custom res-hidden" id="resCustomNetworkFields"/);
  });

  it('are toggled by the preset select and restored from the saved conditions', () => {
    expect(resilience).toMatch(/customFields\.classList\.toggle\('res-hidden', networkSelect\.value !== 'custom'\)/);
    expect(resilience).toMatch(/customFields\.classList\.add\('res-hidden'\)/);
    expect(resilience).toMatch(/customFields\.classList\.remove\('res-hidden'\)/);
  });

  it('are no longer part of the Resilience panel', () => {
    expect(resilience).not.toContain('id="resNetworkSelect"');
    expect(resilience).not.toContain('id="resCpuSelect"');
    expect(emulation).toContain('id="resNetworkSelect"');
    expect(emulation).toContain('id="resCpuSelect"');
  });
});
