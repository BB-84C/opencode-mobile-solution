export type TranscriptFollowState = {
  didInitialScroll: boolean;
  atBottom: boolean;
  userInteracting: boolean;
  contentHeight: number;
  viewportHeight: number;
  offsetY: number;
  returningToBottom: boolean;
};

export type TranscriptFollowEvent =
  | { type: 'reset' }
  | { type: 'layout'; viewportHeight: number }
  | { type: 'interaction'; active: boolean }
  | { type: 'scroll'; contentHeight: number; viewportHeight: number; offsetY: number; atBottom: boolean }
  | { type: 'request-follow' }
  | { type: 'initial-settled' };

export type TranscriptFollowDecision = {
  state: TranscriptFollowState;
  shouldJumpToLatest: boolean;
};

export function createTranscriptFollowState(): TranscriptFollowState {
  return {
    didInitialScroll: false,
    atBottom: true,
    userInteracting: false,
    contentHeight: 0,
    viewportHeight: 0,
    offsetY: 0,
    returningToBottom: false,
  };
}

/**
 * Pure latest-anchor state for an inverted transcript. Native offset zero is
 * the only bottom signal; layout/content growth never emits another scroll
 * command. FlatList's maintainVisibleContentPosition owns streamed growth.
 */
export function reduceTranscriptFollow(
  current: TranscriptFollowState,
  event: TranscriptFollowEvent,
): TranscriptFollowDecision {
  if (event.type === 'reset') {
    return noFollow(createTranscriptFollowState());
  }

  if (event.type === 'layout') {
    return noFollow({ ...current, viewportHeight: Math.max(0, event.viewportHeight) });
  }

  if (event.type === 'interaction') {
    const cancelsInitialFollow = event.active && !current.didInitialScroll;
    return noFollow({
      ...current,
      didInitialScroll: current.didInitialScroll || cancelsInitialFollow,
      userInteracting: event.active,
      returningToBottom: event.active ? false : current.returningToBottom,
    });
  }

  if (event.type === 'scroll') {
    const reachedBottom = event.atBottom;
    return {
      state: {
        ...current,
        contentHeight: Math.max(0, event.contentHeight),
        viewportHeight: Math.max(0, event.viewportHeight),
        offsetY: Math.max(0, event.offsetY),
        didInitialScroll: current.didInitialScroll,
        atBottom: reachedBottom,
        returningToBottom: reachedBottom ? false : current.returningToBottom,
      },
      shouldJumpToLatest: false,
    };
  }

  if (event.type === 'request-follow') {
    return {
      state: { ...current, userInteracting: false, returningToBottom: true },
      shouldJumpToLatest: true,
    };
  }

  if (current.didInitialScroll || current.userInteracting || !current.atBottom) return noFollow(current);
  return noFollow({ ...current, didInitialScroll: true, returningToBottom: false });
}

function noFollow(state: TranscriptFollowState): TranscriptFollowDecision {
  return { state, shouldJumpToLatest: false };
}
