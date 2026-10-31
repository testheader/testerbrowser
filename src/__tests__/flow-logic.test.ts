import { recordFlowStep, vrFlowStep } from '../../renderer/flow-logic.js';

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

describe('vrFlowStep', () => {
  const base = { hasBaseline: true, hasResult: true, regionVisited: false, baselineSaved: false };
  it('rests on Compare with no baseline or no result', () => {
    expect(vrFlowStep({ ...base, hasBaseline: false })).toBe(0);
    expect(vrFlowStep({ ...base, hasResult: false })).toBe(0);
  });
  it('is on Review changes after a comparison', () => {
    expect(vrFlowStep(base)).toBe(1);
  });
  it('moves to Save / export once a region has been visited', () => {
    expect(vrFlowStep({ ...base, regionVisited: true })).toBe(3);
    expect(vrFlowStep({ ...base, regionVisited: true, baselineSaved: true })).toBe(3);
  });
});
