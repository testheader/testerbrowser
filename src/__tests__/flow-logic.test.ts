import { recordFlowStep } from '../../renderer/flow-logic.js';

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
