import type { Agent, MessageWithParts } from '@/src/opencode/types';

export function getSelectableAgents(agents: Agent[]) {
  return agents.filter((agent) => agent.mode !== 'subagent' && !agent.hidden);
}

export function selectionFromLastUserMessage(
  messages: MessageWithParts[],
  agents: Agent[],
): { agentName?: string; variant?: string } {
  const selectable = getSelectableAgents(agents);
  const message = [...messages].reverse().find((item) => item.info.role === 'user');
  if (!message?.info.agent || !selectable.some((agent) => agent.name === message.info.agent)) return {};
  const model = message.info.model;
  const variant =
    typeof model === 'object' && model !== null && !Array.isArray(model)
      ? stringValue((model as Record<string, unknown>).variant)
      : stringValue((message.info as unknown as Record<string, unknown>).variant);
  return { agentName: message.info.agent, ...(variant ? { variant } : {}) };
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}
