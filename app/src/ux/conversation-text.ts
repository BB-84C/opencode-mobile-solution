import { markdownToHtml } from '@/src/components/opencode/math-html';
import type { MessagePart, MessageWithParts } from '@/src/opencode/types';

/**
 * The loaded conversation as one plain string, for the "Select text" sheet.
 *
 * A phone cannot drag a selection from one message card into the next, so the
 * sheet shows every message in one text view instead. `focusOffset` is where
 * the message the user opened it from begins, so the sheet can scroll there.
 */
type Section = { id: string; who: string; body: string };

function sections(messages: MessageWithParts[]): Section[] {
  return messages.flatMap((message) => {
    const body = message.parts.map(partText).filter(Boolean).join('\n\n').trim();
    if (!body) return [];
    const who = message.info.role === 'user' ? 'You' : `Assistant${message.info.agent ? ` · ${message.info.agent}` : ''}`;
    return [{ id: message.info.id, who, body }];
  });
}

export function conversationText(messages: MessageWithParts[], focusMessageId?: string) {
  let text = '';
  let focusOffset = 0;
  for (const section of sections(messages)) {
    if (text) text += '\n\n';
    if (section.id === focusMessageId) focusOffset = text.length;
    text += `── ${section.who} ──\n${section.body}`;
  }
  return { text, focusOffset };
}

/**
 * The same conversation as HTML with typeset math, for the phone, where only a
 * WebView can show formulas. The focused message carries id="focus".
 */
export function conversationHtml(messages: MessageWithParts[], focusMessageId?: string) {
  return sections(messages)
    .map((section) => {
      const focus = section.id === focusMessageId ? ' id="focus"' : '';
      return `<div class="speaker"${focus}>── ${escapeHtml(section.who)} ──</div>${markdownToHtml(section.body)}`;
    })
    .join('\n');
}

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function partText(part: MessagePart): string {
  const record = part as Record<string, unknown>;
  if (part.type === 'text') return typeof record.text === 'string' && !record.synthetic ? record.text : '';
  if (part.type === 'file') return `[file: ${String(record.filename ?? record.url ?? 'attachment')}]`;
  if (part.type === 'tool') {
    const state = (record.state ?? {}) as Record<string, unknown>;
    const input = (state.input ?? {}) as Record<string, unknown>;
    const detail = input.command ?? input.description ?? input.filePath ?? input.pattern ?? state.title ?? '';
    return `[${String(record.tool ?? 'tool')}] ${String(detail)}`.trim();
  }
  return '';
}
