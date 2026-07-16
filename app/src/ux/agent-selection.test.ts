import { describe, expect, it } from 'vitest';

import { getSelectableAgents, selectionFromLastUserMessage } from './agent-selection';

describe('OpenCode TUI agent selection', () => {
  it('keeps primary/all agents and excludes hidden agents and subagents', () => {
    expect(
      getSelectableAgents([
        { name: 'build', mode: 'primary' },
        { name: 'orchestrator' },
        { name: 'explorer', mode: 'subagent' },
        { name: 'hidden-primary', mode: 'primary', hidden: true },
      ]),
    ).toEqual([{ name: 'build', mode: 'primary' }, { name: 'orchestrator' }]);
  });

  it('restores agent and variant from the last user message only when the agent is selectable', () => {
    const agents = [
      { name: 'orchestrator', mode: 'primary' },
      { name: 'explorer', mode: 'subagent' },
    ];
    const messages = [
      {
        info: {
          id: 'm1',
          role: 'user' as const,
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'gpt-5', variant: 'max' },
        } as any,
        parts: [{ type: 'text' as const, text: 'first' }],
      },
      {
        info: { id: 'm2', role: 'assistant' as const, agent: 'orchestrator' },
        parts: [{ type: 'text' as const, text: 'answer' }],
      },
    ];

    expect(selectionFromLastUserMessage(messages, agents)).toEqual({ agentName: 'orchestrator', variant: 'max' });
    expect(
      selectionFromLastUserMessage(
        [{ info: { id: 'm3', role: 'user', agent: 'explorer' }, parts: [{ type: 'text', text: 'child' }] } as any],
        agents,
      ),
    ).toEqual({});
  });
});
