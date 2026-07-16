import { describe, expect, it } from 'vitest';

import { extractPromptUsage } from './prompt-usage';

describe('prompt usage extraction', () => {
  it('extracts usage from status metadata', () => {
    expect(
      extractPromptUsage({
        status: { running: false, usage: { input_tokens: 100, output_tokens: 25, cost_usd: 0.0042 } } as any,
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 25, totalTokens: undefined, costUsd: 0.0042 });
  });

  it('falls back to the latest message or part usage metadata', () => {
    expect(
      extractPromptUsage({
        messages: [
          {
            info: { id: 'm1', role: 'assistant' },
            parts: [{ type: 'text', text: 'older', usage: { totalTokens: 10 } } as any],
          },
          {
            info: { id: 'm2', role: 'assistant', usage: { totalTokens: 1500, costUsd: 0.0123 } } as any,
            parts: [{ type: 'text', text: 'newer' }],
          },
        ],
      }),
    ).toEqual({ inputTokens: undefined, outputTokens: undefined, totalTokens: 1500, costUsd: 0.0123 });
  });
});
