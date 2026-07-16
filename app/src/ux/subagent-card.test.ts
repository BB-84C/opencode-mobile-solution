import { describe, expect, it } from 'vitest';

import type { ToolPart } from '@/src/opencode/types';

import { createSubagentCardModel } from './subagent-card';

describe('subagent card model', () => {
  it('opens child session transcripts and shows metadata when the task part provides it', () => {
    const part: ToolPart = {
      type: 'tool',
      tool: 'task',
      state: {
        metadata: {
          sessionId: 'child-1',
          status: 'completed',
          toolCallCount: 3,
          elapsedMs: 1_500,
        },
      },
    };

    expect(createSubagentCardModel(part)).toEqual({
      title: 'Subagent task',
      sessionId: 'child-1',
      status: 'completed',
      detailLines: ['Status completed', '3 tool calls', 'Elapsed 1.5s'],
      action: { type: 'navigate', label: 'Open transcript', sessionId: 'child-1' },
    });
  });

  it('uses session status as a fallback when metadata has no status', () => {
    const part: ToolPart = {
      type: 'tool_result',
      tool: 'task',
      state: {
        metadata: {
          sessionID: 'child-retry',
          tools: ['read', 'bash'],
        },
      },
    };

    expect(
      createSubagentCardModel(part, {
        statuses: {
          'child-retry': { type: 'retry', message: 'rate limited' },
        },
      }),
    ).toMatchObject({
      sessionId: 'child-retry',
      status: 'retry',
      detailLines: ['Status retry', '2 tool calls'],
    });
  });

  it('derives elapsed time from tool state start and end timestamps when available', () => {
    const part: ToolPart = {
      type: 'tool_result',
      tool: 'task',
      state: {
        status: 'completed',
        metadata: {
          sessionId: 'child-time',
        },
        time: {
          start: 1_000,
          end: 3_400,
        },
      },
    };

    expect(createSubagentCardModel(part)).toMatchObject({
      status: 'completed',
      detailLines: ['Status completed', 'Elapsed 2.4s'],
    });
  });

  it('keeps the subagent card visible but disables transcript navigation when child session metadata is missing', () => {
    const part: ToolPart = {
      type: 'tool_use',
      tool: 'task',
      state: { input: { description: 'investigate' } },
    };

    expect(createSubagentCardModel(part)).toMatchObject({
      status: 'running',
      detailLines: ['Status running'],
      action: {
        type: 'disabled',
        label: 'Transcript unavailable',
        detail: 'Child session metadata is missing from this task part',
      },
    });
  });

  it('ignores ordinary non-task tools', () => {
    expect(createSubagentCardModel({ type: 'tool_result', tool: 'bash', state: {} })).toBeNull();
  });
});
