import type { MessagePart, MessageWithParts, Session } from '@/src/opencode/types';

export function createSessionExportArtifact({
  session,
  messages,
}: {
  session?: Session;
  messages: MessageWithParts[];
}) {
  return JSON.stringify(
    {
      format: 'opencode-mobile-session-export.v1',
      sessionId: session?.id ?? null,
      title: session?.title ?? null,
      workspace: session?.directory ?? session?.path ?? null,
      messageCount: messages.length,
      messages: messages.map((message) => ({
        id: message.info.id,
        role: message.info.role,
        agent: message.info.agent ?? null,
        created: message.info.created ?? message.info.time?.created ?? null,
        text: message.parts.map(partToExportText).filter(Boolean).join('\n'),
        parts: message.parts,
      })),
    },
    null,
    2,
  );
}

function partToExportText(part: MessagePart): string {
  if (part.type === 'text') return String(part.text);
  if (part.type === 'reasoning') return typeof part.text === 'string' ? part.text : JSON.stringify(part);
  if (part.type === 'file') {
    const filename = typeof part.filename === 'string' ? part.filename : undefined;
    const url = typeof part.url === 'string' ? part.url : undefined;
    return filename ?? url ?? '[file]';
  }
  return JSON.stringify(part, null, 2);
}
