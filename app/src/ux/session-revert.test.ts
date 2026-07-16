import { describe, expect, it } from 'vitest';

import type { MessageWithParts } from '@/src/opencode/types';
import { findRedoMessageId, findUndoMessageId } from './session-revert';

const messages: MessageWithParts[] = [
  { info: { id: 'm1', role: 'user' }, parts: [] },
  { info: { id: 'm2', role: 'assistant' }, parts: [] },
  { info: { id: 'm3', role: 'user' }, parts: [] },
  { info: { id: 'm4', role: 'assistant' }, parts: [] },
  { info: { id: 'm5', role: 'user' }, parts: [] },
];

describe('session revert cursor helpers', () => {
  it('finds the latest user message when the session has no revert cursor', () => {
    expect(findUndoMessageId(messages, null)).toBe('m5');
    expect(findRedoMessageId(messages, null)).toBeNull();
  });

  it('finds undo before and redo after the current revert cursor', () => {
    expect(findUndoMessageId(messages, 'm3')).toBe('m1');
    expect(findRedoMessageId(messages, 'm3')).toBe('m5');
  });

  it('returns null when no previous or next user message exists', () => {
    expect(findUndoMessageId(messages, 'm1')).toBeNull();
    expect(findRedoMessageId(messages, 'm5')).toBeNull();
  });
});
