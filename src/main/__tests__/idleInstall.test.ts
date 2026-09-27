import { canAutoInstall, IDLE_INSTALL_MINUTES } from '../idleInstall';

const ALL_CLEAR = {
  enabled: true,
  status: 'downloaded',
  idleSeconds: IDLE_INSTALL_MINUTES * 60,
  recording: false,
  following: false,
  playing: false,
  downloading: false,
};

describe('canAutoInstall (#259)', () => {
  it('is ok when every condition is clear', () => {
    expect(canAutoInstall(ALL_CLEAR)).toEqual({ ok: true });
  });

  it('blocks when the setting is off', () => {
    expect(canAutoInstall({ ...ALL_CLEAR, enabled: false })).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('blocks when the status is not "downloaded"', () => {
    expect(canAutoInstall({ ...ALL_CLEAR, status: 'available' })).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('blocks when the system has not been idle long enough', () => {
    expect(canAutoInstall({ ...ALL_CLEAR, idleSeconds: IDLE_INSTALL_MINUTES * 60 - 1 }))
      .toEqual({ ok: false, reason: expect.any(String) });
  });

  it('is ok at exactly the idle threshold', () => {
    expect(canAutoInstall({ ...ALL_CLEAR, idleSeconds: IDLE_INSTALL_MINUTES * 60 })).toEqual({ ok: true });
  });

  it('blocks while a recording is active', () => {
    expect(canAutoInstall({ ...ALL_CLEAR, recording: true })).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('blocks while a Follow Along pairing is active', () => {
    expect(canAutoInstall({ ...ALL_CLEAR, following: true })).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('blocks while a playback run is in progress', () => {
    expect(canAutoInstall({ ...ALL_CLEAR, playing: true })).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('blocks while a download is in progress', () => {
    expect(canAutoInstall({ ...ALL_CLEAR, downloading: true })).toEqual({ ok: false, reason: expect.any(String) });
  });
});
