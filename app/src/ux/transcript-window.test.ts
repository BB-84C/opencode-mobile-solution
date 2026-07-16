import { describe, expect, it } from 'vitest';

import {
  growTranscriptWindow,
  INITIAL_TRANSCRIPT_WINDOW,
  selectTranscriptWindow,
} from './transcript-window';

describe('transcript render window', () => {
  it('starts at the real latest edge without handing the whole history to native layout', () => {
    const transcript = Array.from({ length: 831 }, (_, index) => index);

    const visible = selectTranscriptWindow(transcript, INITIAL_TRANSCRIPT_WINDOW);

    expect(visible).toHaveLength(100);
    expect(visible[0]).toBe(731);
    expect(visible.at(-1)).toBe(830);
  });

  it('reveals older history in bounded steps until the complete transcript is available', () => {
    expect(growTranscriptWindow(100, 831)).toBe(200);
    expect(growTranscriptWindow(800, 831)).toBe(831);
    expect(growTranscriptWindow(831, 831)).toBe(831);
  });
});
