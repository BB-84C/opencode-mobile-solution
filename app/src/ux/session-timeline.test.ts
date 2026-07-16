import { describe, expect, it } from 'vitest';

import type { MessageWithParts } from '@/src/opencode/types';

import { createSessionTimelineModel } from './session-timeline';

describe('createSessionTimelineModel', () => {
  it('builds TUI-style jump entries from transcript messages', () => {
    const messages: MessageWithParts[] = [
      {
        info: { id: 'm1', role: 'user', created: '2026-07-09T12:00:00.000Z' },
        parts: [{ type: 'text', text: 'Run diagnostics' }],
      },
      {
        info: { id: 'm2', role: 'assistant', agent: 'orchestrator' },
        parts: [{ type: 'reasoning', text: 'Thinking about a safe plan' }],
      },
    ];

    expect(createSessionTimelineModel(messages, 'm2')).toEqual({
      title: 'Timeline',
      entries: [
        {
          id: 'm1',
          label: '1. You',
          detail: '2026-07-09T12:00:00.000Z · Run diagnostics',
          selected: false,
        },
        {
          id: 'm2',
          label: '2. Agent · orchestrator',
          detail: 'Thinking about a safe plan',
          selected: true,
        },
      ],
    });
  });
});
