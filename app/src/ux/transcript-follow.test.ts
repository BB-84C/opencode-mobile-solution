import { describe, expect, it } from 'vitest';

import { createTranscriptFollowState, reduceTranscriptFollow } from './transcript-follow';

describe('inverted transcript latest-anchor state', () => {
  it('settles the initial anchor only after the native latest row is visible', () => {
    const measured = reduceTranscriptFollow(createTranscriptFollowState(), {
      type: 'scroll',
      contentHeight: 1200,
      viewportHeight: 400,
      offsetY: 0,
      atBottom: true,
    });

    expect(measured.state).toMatchObject({ didInitialScroll: false, atBottom: true, offsetY: 0 });
    expect(measured.shouldJumpToLatest).toBe(false);

    const settled = reduceTranscriptFollow(measured.state, { type: 'initial-settled' });
    expect(settled.state).toMatchObject({ didInitialScroll: true, atBottom: true });
    expect(settled.shouldJumpToLatest).toBe(false);
  });

  it('reports history reading from the inverted native distance without issuing a retry', () => {
    const settled = reduceTranscriptFollow(
      reduceTranscriptFollow(createTranscriptFollowState(), { type: 'initial-settled' }).state,
      {
        type: 'scroll',
        contentHeight: 1200,
        viewportHeight: 400,
        offsetY: 280,
        atBottom: false,
      },
    );

    expect(settled.state).toMatchObject({ atBottom: false, offsetY: 280 });
    expect(settled.shouldJumpToLatest).toBe(false);
  });

  it('emits exactly one immediate latest jump and waits for native offset zero confirmation', () => {
    const readingHistory = reduceTranscriptFollow(
      reduceTranscriptFollow(createTranscriptFollowState(), { type: 'initial-settled' }).state,
      {
        type: 'scroll',
        contentHeight: 1200,
        viewportHeight: 400,
        offsetY: 250,
        atBottom: false,
      },
    ).state;

    const requested = reduceTranscriptFollow(readingHistory, { type: 'request-follow' });
    expect(requested.shouldJumpToLatest).toBe(true);
    expect(requested.state).toMatchObject({ atBottom: false, returningToBottom: true });

    const intermediate = reduceTranscriptFollow(requested.state, {
      type: 'scroll',
      contentHeight: 1200,
      viewportHeight: 400,
      offsetY: 100,
      atBottom: false,
    });
    expect(intermediate.shouldJumpToLatest).toBe(false);
    expect(intermediate.state).toMatchObject({ atBottom: false, returningToBottom: true });

    const reached = reduceTranscriptFollow(intermediate.state, {
      type: 'scroll',
      contentHeight: 1200,
      viewportHeight: 400,
      offsetY: 0,
      atBottom: true,
    });
    expect(reached.shouldJumpToLatest).toBe(false);
    expect(reached.state).toMatchObject({ atBottom: true, returningToBottom: false });
  });

  it('a user drag cancels a pending return and reset restores initial semantics', () => {
    const requested = reduceTranscriptFollow(createTranscriptFollowState(), { type: 'request-follow' }).state;
    const dragging = reduceTranscriptFollow(requested, { type: 'interaction', active: true });

    expect(dragging.state).toMatchObject({ userInteracting: true, returningToBottom: false });
    expect(dragging.shouldJumpToLatest).toBe(false);
    expect(reduceTranscriptFollow(dragging.state, { type: 'reset' }).state).toEqual(createTranscriptFollowState());
  });
});
