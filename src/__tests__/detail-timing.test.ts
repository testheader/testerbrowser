import { timingPhases, timingBars, parseCookieHeader, parseSetCookies } from '../../renderer/utils.js';

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

describe('timingBars (#301)', () => {
  it('lists the five phases in order, with Queued as the lead-in before network activity', () => {
    const bars = timingBars({
      dnsStart: 5, dnsEnd: 15, connectStart: 15, connectEnd: 45, sendStart: 45, sendEnd: 46, receiveHeadersEnd: 100,
    }, 130);
    expect(bars.map((b) => b.label)).toEqual(['Queued', 'DNS lookup', 'Connection', 'Waiting (TTFB)', 'Download']);
    expect(bars.map((b) => b.ms)).toEqual([5, 10, 30, 54, 30]);
  });

  it('reports null for phases a reused connection skips', () => {
    const bars = timingBars({ dnsStart: -1, dnsEnd: -1, connectStart: -1, connectEnd: -1, sendStart: 2, sendEnd: 3, receiveHeadersEnd: 20 }, 25);
    expect(bars.find((b) => b.key === 'dns')?.ms).toBeNull();
    expect(bars.find((b) => b.key === 'connect')?.ms).toBeNull();
    expect(bars.find((b) => b.key === 'queued')?.ms).toBe(2);
  });
});

describe('cookie parsing for the Cookies tab (#301)', () => {
  it('parses a Cookie request header', () => {
    expect(parseCookieHeader('a=1; b=two=2; flag')).toEqual([
      { name: 'a', value: '1' }, { name: 'b', value: 'two=2' }, { name: 'flag', value: '' },
    ]);
    expect(parseCookieHeader('')).toEqual([]);
  });

  it('parses newline-joined Set-Cookie headers with their attributes', () => {
    expect(parseSetCookies('sid=abc; Path=/; HttpOnly\nx=1; Secure')).toEqual([
      { name: 'sid', value: 'abc', attrs: ['Path=/', 'HttpOnly'] },
      { name: 'x', value: '1', attrs: ['Secure'] },
    ]);
    expect(parseSetCookies(undefined)).toEqual([]);
  });
});
