import { describe, expect, it } from 'vitest';

import { calculateTranscriptScrollState, shouldFollowTranscriptGrowth } from './transcript-scroll';

describe('transcript sticky-bottom behavior', () => {
  it('treats a transcript within the bottom threshold as following', () => {
    expect(calculateTranscriptScrollState({ contentHeight: 1000, viewportHeight: 400, offsetY: 570 }).atBottom).toBe(true);
    expect(calculateTranscriptScrollState({ contentHeight: 1000, viewportHeight: 400, offsetY: 400 }).atBottom).toBe(false);
  });

  it('follows initial layout and new content only while the user remains at the bottom', () => {
    expect(shouldFollowTranscriptGrowth({ didInitialScroll: false, wasAtBottom: false })).toBe(true);
    expect(shouldFollowTranscriptGrowth({ didInitialScroll: true, wasAtBottom: true })).toBe(true);
    expect(shouldFollowTranscriptGrowth({ didInitialScroll: true, wasAtBottom: false })).toBe(false);
  });

  it('calculates a stable themed thumb without exceeding its track', () => {
    expect(calculateTranscriptScrollState({ contentHeight: 1200, viewportHeight: 400, offsetY: 400 })).toEqual({
      atBottom: false,
      thumbRatio: 1 / 3,
      thumbProgress: 0.5,
    });
  });
});
