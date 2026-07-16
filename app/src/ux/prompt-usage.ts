import type { MessageWithParts, Session, SessionStatus } from '@/src/opencode/types';
import type { PromptUsageMetadata } from './prompt-footer';

export function extractPromptUsage({
  session,
  status,
  messages,
}: {
  session?: Session;
  status?: SessionStatus;
  messages?: MessageWithParts[];
}): PromptUsageMetadata | undefined {
  return (
    usageFromRecord(recordValue(status)) ??
    usageFromRecord(recordValue(session)) ??
    usageFromMessages(messages ?? [])
  );
}

function usageFromMessages(messages: MessageWithParts[]) {
  for (const message of [...messages].reverse()) {
    const infoUsage = usageFromRecord(recordValue(message.info));
    if (infoUsage) return infoUsage;
    for (const part of [...message.parts].reverse()) {
      const partUsage = usageFromRecord(recordValue(part));
      if (partUsage) return partUsage;
    }
  }
  return undefined;
}

function usageFromRecord(record: Record<string, unknown> | undefined): PromptUsageMetadata | undefined {
  if (!record) return undefined;
  const nested = recordValue(record.usage) ?? recordValue(record.tokens);
  const source = nested ?? record;
  const inputTokens = numberValue(source.inputTokens ?? source.input_tokens ?? source.promptTokens ?? source.prompt_tokens);
  const outputTokens = numberValue(
    source.outputTokens ?? source.output_tokens ?? source.completionTokens ?? source.completion_tokens,
  );
  const totalTokens = numberValue(source.totalTokens ?? source.total_tokens);
  const costUsd = numberValue(source.costUsd ?? source.cost_usd ?? source.cost);
  if (
    typeof inputTokens !== 'number' &&
    typeof outputTokens !== 'number' &&
    typeof totalTokens !== 'number' &&
    typeof costUsd !== 'number'
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens, costUsd };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
