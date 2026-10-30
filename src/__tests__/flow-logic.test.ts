import { recordFlowStep, mockFlowStep, resilienceFlowStep } from '../../renderer/flow-logic.js';

describe('recordFlowStep', () => {
  it('starts at Record with nothing recorded or saved', () => {
    expect(recordFlowStep({ isRecording: false, unsavedSteps: 0, savedCount: 0 })).toBe(0);
  });
  it('moves to Assert while recording, even with saved tests', () => {
    expect(recordFlowStep({ isRecording: true, unsavedSteps: 3, savedCount: 2 })).toBe(1);
  });
  it('moves to Save once stopped with unsaved steps', () => {
    expect(recordFlowStep({ isRecording: false, unsavedSteps: 4, savedCount: 0 })).toBe(2);
  });
  it('rests on Run when idle with saved tests', () => {
    expect(recordFlowStep({ isRecording: false, unsavedSteps: 0, savedCount: 1 })).toBe(3);
  });
});

describe('mockFlowStep / resilienceFlowStep', () => {
  it('asks for a rule first', () => {
    expect(mockFlowStep({ rules: [] })).toBe(0);
  });
  it('asks to enable when every rule is disabled', () => {
    expect(mockFlowStep({ rules: [{ enabled: false }] })).toBe(1);
  });
  it('waits for a matching request while enabled and unhit', () => {
    expect(mockFlowStep({ rules: [{ enabled: true, hitCount: 0 }] })).toBe(2);
    expect(mockFlowStep({ rules: [{ hitCount: 0 }] })).toBe(2); // enabled defaults to on
  });
  it('is finished once any rule has been hit', () => {
    expect(mockFlowStep({ rules: [{ enabled: true, hitCount: 0 }, { enabled: true, hitCount: 2 }] })).toBe(3);
  });
  it('resilience follows the same progression', () => {
    expect(resilienceFlowStep({ rules: [] })).toBe(0);
    expect(resilienceFlowStep({ rules: [{ enabled: true, hitCount: 1 }] })).toBe(3);
  });
});
