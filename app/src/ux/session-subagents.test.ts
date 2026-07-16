import { describe, expect, it } from 'vitest';

import { createSessionSubagentListModel } from './session-subagents';

describe('createSessionSubagentListModel', () => {
  it('extracts child session identities from task tool parts', () => {
    const model = createSessionSubagentListModel(
      [
        {
          info: { id: 'm-task', role: 'assistant' },
          parts: [
            {
              type: 'tool',
              tool: 'task',
              state: {
                metadata: {
                  sessionId: 'child-session',
                  status: 'running',
                  toolCallCount: 3,
                  elapsedMs: 1500,
                },
              },
            },
          ],
        },
      ],
      { statuses: { 'child-session': { type: 'busy' } } },
    );

    expect(model.entries).toEqual([
      {
        id: 'subagent-child-session',
        label: 'Subagent child-session',
        detail: 'Status running · 3 tool calls · Elapsed 1.5s',
        disabled: false,
        sessionId: 'child-session',
      },
    ]);
  });

  it('keeps task entries visible when child transcript metadata is missing', () => {
    const model = createSessionSubagentListModel([
      {
        info: { id: 'm-task', role: 'assistant' },
        parts: [{ type: 'tool', tool: 'task', state: {} }],
      },
    ]);

    expect(model.entries).toMatchObject([
      {
        id: 'subagent-m-task-0',
        label: 'Subagent task',
        disabled: true,
      },
    ]);
    expect(model.entries[0].detail).toContain('Child session metadata is missing');
  });
});
