import fs from 'fs';
import path from 'path';

const renderer = path.join(__dirname, '..', '..', 'renderer');
const throttle = fs.readFileSync(path.join(renderer, 'throttle.js'), 'utf8');
const emulation = fs.readFileSync(path.join(renderer, 'emulation.js'), 'utf8');

// #330: Latency / Download / Upload only show when the network preset is "Custom".
// #341: the throttling controls live in Spoof › Advanced, not Resilience.
describe('custom throttle fields', () => {
  it('start hidden in the Spoof markup', () => {
    expect(emulation).toMatch(/spoof-throttle-custom res-hidden" id="resCustomNetworkFields"/);
  });

  it('are toggled by the preset select and restored from the saved conditions', () => {
    expect(throttle).toMatch(/customFields\.classList\.toggle\('res-hidden', networkSelect\.value !== 'custom'\)/);
    expect(throttle).toMatch(/customFields\.classList\.add\('res-hidden'\)/);
    expect(throttle).toMatch(/customFields\.classList\.remove\('res-hidden'\)/);
  });

  it('are no longer part of the Resilience panel', () => {
    expect(throttle).not.toContain('id="resNetworkSelect"');
    expect(throttle).not.toContain('id="resCpuSelect"');
    expect(emulation).toContain('id="resNetworkSelect"');
    expect(emulation).toContain('id="resCpuSelect"');
  });
});
