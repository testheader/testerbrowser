import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'resilience.js'), 'utf8');

// #330: Latency / Download / Upload only show when the network preset is "Custom".
describe('renderer/resilience.js custom throttle fields', () => {
  it('start hidden in the markup', () => {
    expect(src).toMatch(/class="res-conditions-custom res-hidden" id="resCustomNetworkFields"/);
  });

  it('are toggled by the preset select and restored from the saved conditions', () => {
    expect(src).toMatch(/customFields\.classList\.toggle\('res-hidden', networkSelect\.value !== 'custom'\)/);
    expect(src).toMatch(/customFields\.classList\.add\('res-hidden'\)/);
    expect(src).toMatch(/customFields\.classList\.remove\('res-hidden'\)/);
  });
});
