import { describe, expect, it } from 'vitest';

import {
  isTranscriptScrollNoop,
  nextTranscriptOffset,
  type TranscriptMetrics,
} from './transcript-scroll-commands';

const metrics = (over: Partial<TranscriptMetrics> = {}): TranscriptMetrics => ({
  offsetY: 500,
  viewportHeight: 800,
  contentHeight: 5_000,
  ...over,
});

describe('transcript scroll commands', () => {
  it('moves toward older messages by increasing the offset', () => {
    // The list is inverted: the newest message is at offset 0. Treating "up" as
    // a smaller offset would scroll the wrong way and look like a broken key.
    expect(nextTranscriptOffset('page-up', metrics())).toBeGreaterThan(500);
    expect(nextTranscriptOffset('page-down', metrics())).toBeLessThan(500);
  });

  it('keeps a sliver of the previous screen, like a pager', () => {
    const moved = nextTranscriptOffset('page-up', metrics({ offsetY: 0 }));

    expect(moved).toBeCloseTo(800 * 0.9);
    expect(moved).toBeLessThan(800);
  });

  it('moves half as far for a half page', () => {
    const full = nextTranscriptOffset('page-up', metrics({ offsetY: 0 }));
    const half = nextTranscriptOffset('half-page-up', metrics({ offsetY: 0 }));

    expect(half).toBeCloseTo(full / 2);
  });

  it('stops at the newest message instead of going negative', () => {
    expect(nextTranscriptOffset('page-down', metrics({ offsetY: 10 }))).toBe(0);
    expect(nextTranscriptOffset('page-down', metrics({ offsetY: 0 }))).toBe(0);
  });

  it('stops at the oldest message instead of scrolling past the content', () => {
    const atEnd = metrics({ offsetY: 4_190, contentHeight: 5_000, viewportHeight: 800 });

    expect(nextTranscriptOffset('page-up', atEnd)).toBe(4_200);
    expect(nextTranscriptOffset('to-oldest', atEnd)).toBe(4_200);
  });

  it('jumps to either end', () => {
    expect(nextTranscriptOffset('to-latest', metrics())).toBe(0);
    expect(nextTranscriptOffset('to-oldest', metrics())).toBe(4_200);
  });

  it('does not produce a negative target when the content is shorter than the viewport', () => {
    const shortTranscript = metrics({ offsetY: 0, contentHeight: 200, viewportHeight: 800 });

    expect(nextTranscriptOffset('page-up', shortTranscript)).toBe(0);
    expect(nextTranscriptOffset('to-oldest', shortTranscript)).toBe(0);
  });

  it('survives metrics that have not been measured yet', () => {
    // Before the first layout the component has zeroes, and a key pressed in
    // that window must not produce NaN and wedge the list.
    const unmeasured: TranscriptMetrics = { offsetY: 0, viewportHeight: 0, contentHeight: 0 };

    for (const command of ['page-up', 'page-down', 'to-oldest', 'to-latest'] as const) {
      expect(Number.isFinite(nextTranscriptOffset(command, unmeasured))).toBe(true);
      expect(nextTranscriptOffset(command, unmeasured)).toBe(0);
    }

    expect(Number.isFinite(nextTranscriptOffset('page-up', metrics({ offsetY: Number.NaN })))).toBe(true);
  });

  it('says when a command cannot move the view, so the key can explain itself', () => {
    expect(isTranscriptScrollNoop('page-down', metrics({ offsetY: 0 }))).toBe(true);
    expect(isTranscriptScrollNoop('to-latest', metrics({ offsetY: 0 }))).toBe(true);
    expect(isTranscriptScrollNoop('page-up', metrics({ offsetY: 4_200 }))).toBe(true);
    expect(isTranscriptScrollNoop('page-up', metrics({ offsetY: 0 }))).toBe(false);
  });
});
