import { describe, expect, it } from 'vitest';

import type { MessageWithParts } from '@/src/opencode/types';
import { sortMessagesChronologically } from './message-order';

function message(id: string, created?: number): MessageWithParts {
  return {
    info: { id, role: 'assistant', time: created === undefined ? undefined : { created } },
    parts: [],
  };
}

describe('message chronology normalization', () => {
  it('merges newest-to-older page runs into one oldest-to-newest transcript', () => {
    const newestPage = [message('new-1', 300), message('new-2', 400)];
    const olderPage = [message('old-1', 100), message('old-2', 200)];

    expect(sortMessagesChronologically([...newestPage, ...olderPage]).map((item) => item.info.id)).toEqual([
      'old-1',
      'old-2',
      'new-1',
      'new-2',
    ]);
  });

  it('keeps equal and not-yet-timestamped live envelopes stable at the newest edge', () => {
    expect(sortMessagesChronologically([
      message('same-a', 100),
      message('live-a'),
      message('same-b', 100),
      message('live-b'),
    ]).map((item) => item.info.id)).toEqual(['same-a', 'same-b', 'live-a', 'live-b']);
  });
});
