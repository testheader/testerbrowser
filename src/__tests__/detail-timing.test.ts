import { timingPhases } from '../../renderer/utils.js';

describe('timingPhases (#261)', () => {
  it('computes every phase from a full CDP ResourceTiming object', () => {
    const timing = {
      dnsStart: 0, dnsEnd: 10,
      connectStart: 10, connectEnd: 40,
      sslStart: 20, sslEnd: 40,
      sendStart: 40, sendEnd: 42,
      receiveHeadersEnd: 100,
    };
    expect(timingPhases(timing, 150)).toEqual({
      dns: 10,
      connect: 30,
      tls: 20,
      send: 2,
      wait: 58,
      receive: 50,
    });
  });

  it('reports null for phases the browser marks as -1 (e.g. a reused connection skips DNS/connect)', () => {
    const timing = {
      dnsStart: -1, dnsEnd: -1,
      connectStart: -1, connectEnd: -1,
      sslStart: -1, sslEnd: -1,
      sendStart: 5, sendEnd: 6,
      receiveHeadersEnd: 50,
    };
    const phases = timingPhases(timing, 60);
    expect(phases.dns).toBeNull();
    expect(phases.connect).toBeNull();
    expect(phases.tls).toBeNull();
    expect(phases.send).toBe(1);
    expect(phases.wait).toBe(44);
    expect(phases.receive).toBe(10);
  });

  it('returns every phase as null when there is no timing object at all', () => {
    expect(timingPhases(undefined, 100)).toEqual({
      dns: null, connect: null, tls: null, send: null, wait: null, receive: null,
    });
  });

  it('clamps a negative-looking gap to 0 instead of a negative number', () => {
    // durationMs measured slightly before receiveHeadersEnd due to clock skew
    // between the recorder's own wall clock and CDP's timing clock.
    const timing = { receiveHeadersEnd: 100 };
    expect(timingPhases(timing, 90).receive).toBe(0);
  });
});
