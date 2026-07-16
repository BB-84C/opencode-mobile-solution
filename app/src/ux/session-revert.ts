import type { MessageWithParts } from '@/src/opencode/types';

export function findUndoMessageId(messages: MessageWithParts[], currentRevertMessageId?: string | null) {
  const endIndex = currentRevertMessageId ? messages.findIndex((message) => message.info.id === currentRevertMessageId) : -1;
  const start = endIndex >= 0 ? endIndex - 1 : messages.length - 1;
  for (let index = start; index >= 0; index -= 1) {
    if (messages[index].info.role === 'user') return messages[index].info.id;
  }
  return null;
}

export function findRedoMessageId(messages: MessageWithParts[], currentRevertMessageId?: string | null) {
  if (!currentRevertMessageId) return null;
  const startIndex = messages.findIndex((message) => message.info.id === currentRevertMessageId);
  if (startIndex < 0) return null;
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    if (messages[index].info.role === 'user') return messages[index].info.id;
  }
  return null;
}
