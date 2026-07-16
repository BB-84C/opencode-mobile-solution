export const INITIAL_TRANSCRIPT_WINDOW = 100;
export const TRANSCRIPT_WINDOW_STEP = 100;

export function selectTranscriptWindow<T>(items: readonly T[], limit: number) {
  const boundedLimit = Math.max(1, Math.floor(limit));
  return items.length <= boundedLimit ? [...items] : items.slice(items.length - boundedLimit);
}

export function growTranscriptWindow(current: number, total: number) {
  return Math.min(total, Math.max(INITIAL_TRANSCRIPT_WINDOW, current + TRANSCRIPT_WINDOW_STEP));
}
