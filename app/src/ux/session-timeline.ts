import type { MessageWithParts } from '@/src/opencode/types';

export interface TimelineEntry {
  id: string;
  label: string;
  detail: string;
  selected: boolean;
}

export function createSessionTimelineModel(messages: MessageWithParts[], selectedMessageId?: string | null) {
  return {
    title: 'Timeline',
    entries: messages.map((message, index) => ({
      id: message.info.id,
      label: `${index + 1}. ${message.info.role === 'user' ? 'You' : message.info.agent ? `Agent · ${message.info.agent}` : 'Agent'}`,
      detail: timelineDetail(message),
      selected: message.info.id === selectedMessageId,
    })),
  };
}

function timelineDetail(message: MessageWithParts) {
  const timestamp = message.info.created ?? (message.info.time?.created ? new Date(message.info.time.created).toISOString() : undefined);
  const preview = message.parts.map(partPreview).join(' ').replace(/\s+/g, ' ').trim().slice(0, 96);
  return [timestamp, preview || 'No text preview'].filter(Boolean).join(' · ');
}

function partPreview(part: MessageWithParts['parts'][number]) {
  if (part.type === 'text') return String(part.text);
  if (part.type === 'reasoning' && typeof part.text === 'string') return part.text;
  if ('tool' in part && typeof part.tool === 'string') return part.tool;
  return part.type;
}
