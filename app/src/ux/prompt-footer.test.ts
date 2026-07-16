import { describe, expect, it } from 'vitest';

import { createPromptFooterModel } from './prompt-footer';

describe('prompt footer model', () => {
  it('shows agent, model, mode, thinking variant, and session status when available', () => {
    const model = createPromptFooterModel({
      agentName: 'orchestrator',
      agentModel: 'anthropic/claude-sonnet-4',
      promptMode: 'ask',
      thinkingLevel: 'high',
      status: { type: 'busy' },
    });

    expect(model.chips).toEqual([
      { id: 'agent', label: 'orchestrator' },
      { id: 'model', label: 'claude-sonnet-4', detail: 'anthropic' },
      { id: 'mode', label: 'ask' },
      { id: 'thinking', label: 'thinking high' },
      { id: 'status', label: 'running' },
    ]);
  });

  it('does not invent token or cost metadata when the API does not provide it', () => {
    const model = createPromptFooterModel({
      agentName: null,
      agentModel: undefined,
      promptMode: 'shell',
      thinkingLevel: 'medium',
      status: { type: 'idle' },
    });

    expect(model.chips.map((chip) => chip.id)).toEqual(['agent', 'mode', 'thinking', 'status']);
    expect(model.chips.map((chip) => chip.id as string)).not.toContain('tokens');
    expect(model.chips.map((chip) => chip.id as string)).not.toContain('cost');
  });

  it('shows token and cost chips when usage metadata is available', () => {
    const model = createPromptFooterModel({
      agentName: 'orchestrator',
      agentModel: 'openai/gpt-5',
      promptMode: 'ask',
      thinkingLevel: 'high',
      status: { type: 'busy' },
      usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.0123 },
    });

    expect(model.chips).toEqual([
      { id: 'agent', label: 'orchestrator' },
      { id: 'model', label: 'gpt-5', detail: 'openai' },
      { id: 'mode', label: 'ask' },
      { id: 'thinking', label: 'thinking high' },
      { id: 'tokens', label: '1,500 tokens' },
      { id: 'cost', label: '$0.0123' },
      { id: 'status', label: 'running' },
    ]);
  });

  it('accepts object-shaped model metadata from the live API', () => {
    const model = createPromptFooterModel({
      agentName: 'orchestrator',
      agentModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      promptMode: 'ask',
      thinkingLevel: 'high',
    });

    expect(model.chips.find((chip) => chip.id === 'model')).toEqual({
      id: 'model',
      label: 'claude-sonnet-4',
      detail: 'anthropic',
    });
  });

  it('maps retry session status to retrying like the TUI footer state', () => {
    const model = createPromptFooterModel({
      agentName: 'orchestrator',
      promptMode: 'ask',
      thinkingLevel: 'high',
      status: { type: 'retry' },
    });

    expect(model.chips.find((chip) => chip.id === 'status')).toEqual({ id: 'status', label: 'retrying' });
  });
});
