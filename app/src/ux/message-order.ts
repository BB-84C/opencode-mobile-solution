import type { MessageWithParts } from '@/src/opencode/types';

/**
 * OpenCode pagination walks newest page to older page while each page is
 * oldest-first. Cache/live reconciliation can therefore contain several
 * individually ordered page runs. Normalize the combined transcript by the
 * message contract's authoritative creation time before presenting it.
 */
export function sortMessagesChronologically(messages: readonly MessageWithParts[]) {
  return messages
    .map((message, index) => ({ message, index, createdAt: messageCreatedAt(message) }))
    .sort((left, right) => {
      const time = left.createdAt - right.createdAt;
      return time !== 0 ? time : left.index - right.index;
    })
    .map(({ message }) => message);
}

function messageCreatedAt(message: MessageWithParts) {
  const numeric = message.info.time?.created;
  if (typeof numeric === 'number' && Number.isFinite(numeric)) return numeric;
  if (message.info.created) {
    const parsed = Date.parse(message.info.created);
    if (Number.isFinite(parsed)) return parsed;
  }
  // A live message can receive parts before its full info envelope. Keep such
  // messages at the live edge until the authoritative timestamp arrives.
  return Number.POSITIVE_INFINITY;
}
