/**
 * Where a keyboard scroll command should land in the transcript.
 *
 * The transcript list is inverted: the newest message sits at native offset 0
 * and older content lives at larger offsets. So "page up", which moves toward
 * older messages, *increases* the offset. Getting that backwards is easy and
 * silent, which is why the arithmetic lives here with tests rather than inline
 * in a component.
 */

export type TranscriptScrollCommand =
  | 'page-up'
  | 'page-down'
  | 'half-page-up'
  | 'half-page-down'
  | 'to-oldest'
  | 'to-latest';

export interface TranscriptMetrics {
  /** Distance from the newest message, in pixels. Zero means pinned to latest. */
  offsetY: number;
  viewportHeight: number;
  contentHeight: number;
}

/** A viewport of scrolling keeps a sliver of the previous screen for continuity,
 *  the way a terminal pager does. */
const PAGE_OVERLAP = 0.1;

export function nextTranscriptOffset(
  command: TranscriptScrollCommand,
  metrics: TranscriptMetrics,
): number {
  const viewport = Math.max(0, metrics.viewportHeight);
  const maxOffset = Math.max(0, metrics.contentHeight - viewport);
  const current = clamp(metrics.offsetY, 0, maxOffset);
  const page = viewport * (1 - PAGE_OVERLAP);

  switch (command) {
    case 'to-latest':
      return 0;
    case 'to-oldest':
      return maxOffset;
    case 'page-up':
      return clamp(current + page, 0, maxOffset);
    case 'page-down':
      return clamp(current - page, 0, maxOffset);
    case 'half-page-up':
      return clamp(current + page / 2, 0, maxOffset);
    case 'half-page-down':
      return clamp(current - page / 2, 0, maxOffset);
    default: {
      const exhaustive: never = command;
      throw new Error(`unknown transcript scroll command: ${String(exhaustive)}`);
    }
  }
}

/** True when the command cannot move the view, so a caller can report that the
 *  transcript is already at the end instead of appearing to do nothing. */
export function isTranscriptScrollNoop(
  command: TranscriptScrollCommand,
  metrics: TranscriptMetrics,
): boolean {
  return nextTranscriptOffset(command, metrics) === clamp(
    metrics.offsetY,
    0,
    Math.max(0, metrics.contentHeight - Math.max(0, metrics.viewportHeight)),
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}
