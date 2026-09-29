import { NETWORK_PRESETS, toCdpNetworkConditions, describeConditions } from '../networkConditions';

describe('NETWORK_PRESETS / toCdpNetworkConditions', () => {
  test('fast3g matches the documented preset values', () => {
    expect(toCdpNetworkConditions('fast3g')).toEqual({
      latency: 562.5,
      downloadThroughput: 180 * 1024 * 0.9,
      uploadThroughput: 84.375 * 1024 * 0.9,
      offline: false,
    });
  });

  test('slow3g matches the documented preset values', () => {
    expect(toCdpNetworkConditions('slow3g')).toEqual({
      latency: 2000,
      downloadThroughput: 50 * 1024 * 0.9,
      uploadThroughput: 50 * 1024 * 0.9,
      offline: false,
    });
  });

  test('offline sets offline:true with unthrottled throughput fields', () => {
    expect(toCdpNetworkConditions('offline')).toEqual({
      latency: 0, downloadThroughput: -1, uploadThroughput: -1, offline: true,
    });
  });

  test('none is the reset/no-throttling params', () => {
    expect(toCdpNetworkConditions('none')).toEqual({
      latency: 0, downloadThroughput: -1, uploadThroughput: -1, offline: false,
    });
  });

  test('custom converts kbps to bytes/s and never returns offline', () => {
    expect(toCdpNetworkConditions({ custom: { latency: 100, downloadKbps: 800, uploadKbps: 400 } })).toEqual({
      latency: 100,
      downloadThroughput: 800 * 1000 / 8,
      uploadThroughput: 400 * 1000 / 8,
      offline: false,
    });
  });

  test('custom clamps negative inputs to 0', () => {
    expect(toCdpNetworkConditions({ custom: { latency: -50, downloadKbps: -1, uploadKbps: -1 } })).toEqual({
      latency: 0, downloadThroughput: 0, uploadThroughput: 0, offline: false,
    });
  });

  test('every named preset key resolves through NETWORK_PRESETS', () => {
    for (const key of Object.keys(NETWORK_PRESETS) as (keyof typeof NETWORK_PRESETS)[]) {
      expect(toCdpNetworkConditions(key)).toBe(NETWORK_PRESETS[key]);
    }
  });
});

describe('describeConditions', () => {
  test('returns null with no conditions', () => {
    expect(describeConditions(undefined)).toBeNull();
    expect(describeConditions(null)).toBeNull();
  });

  test('returns null when both network and CPU are unthrottled', () => {
    expect(describeConditions({ network: 'none', cpuRate: 1 })).toBeNull();
  });

  test('describes network-only throttling', () => {
    expect(describeConditions({ network: 'slow3g', cpuRate: 1 })).toBe('Throttled: Slow 3G');
  });

  test('describes CPU-only throttling', () => {
    expect(describeConditions({ network: 'none', cpuRate: 4 })).toBe('Throttled: CPU 4×');
  });

  test('describes both together', () => {
    expect(describeConditions({ network: 'slow3g', cpuRate: 6 })).toBe('Throttled: Slow 3G · CPU 6×');
  });

  test('describes a custom network selection', () => {
    expect(describeConditions({ network: { custom: { latency: 10, downloadKbps: 100, uploadKbps: 50 } }, cpuRate: 1 }))
      .toBe('Throttled: Custom');
  });
});
