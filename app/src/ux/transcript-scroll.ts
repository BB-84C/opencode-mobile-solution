const bottomThreshold = 48;

export function calculateTranscriptScrollState({
  contentHeight,
  viewportHeight,
  offsetY,
}: {
  contentHeight: number;
  viewportHeight: number;
  offsetY: number;
}) {
  const scrollable = Math.max(0, contentHeight - viewportHeight);
  const clampedOffset = Math.min(Math.max(0, offsetY), scrollable);
  return {
    atBottom: scrollable - clampedOffset <= bottomThreshold,
    thumbRatio: contentHeight > 0 ? Math.min(1, viewportHeight / contentHeight) : 1,
    thumbProgress: scrollable > 0 ? clampedOffset / scrollable : 1,
  };
}

export function shouldFollowTranscriptGrowth({
  didInitialScroll,
  wasAtBottom,
}: {
  didInitialScroll: boolean;
  wasAtBottom: boolean;
}) {
  return !didInitialScroll || wasAtBottom;
}
