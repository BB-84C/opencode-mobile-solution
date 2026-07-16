import type { MessageWithParts, SessionStatus, ToolPart } from '@/src/opencode/types';
import { createSubagentCardModel } from './subagent-card';

export interface SessionSubagentEntry {
  id: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  sessionId?: string;
}

export function createSessionSubagentListModel(
  messages: MessageWithParts[],
  options: { statuses?: Record<string, SessionStatus> } = {},
) {
  const entries: SessionSubagentEntry[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    message.parts.forEach((part, index) => {
      if (part.type !== 'tool' && part.type !== 'tool_use' && part.type !== 'tool_result') return;
      const model = createSubagentCardModel(part as ToolPart, options);
      if (!model) return;

      const key = model.sessionId ?? `${message.info.id}-${index}`;
      if (seen.has(key)) return;
      seen.add(key);

      entries.push({
        id: `subagent-${key}`,
        label: model.sessionId ? `Subagent ${model.sessionId}` : model.title,
        detail:
          model.action.type === 'disabled'
            ? `${model.detailLines.join(' · ')} · ${model.action.detail}`
            : model.detailLines.join(' · '),
        disabled: model.action.type === 'disabled',
        sessionId: model.action.type === 'navigate' ? model.action.sessionId : undefined,
      });
    });
  }

  return {
    title: 'Subagents',
    entries,
    empty: entries.length === 0,
  };
}
