import { formatModelDisplay, type ModelLike } from '@/src/opencode/model-ref';
import type { SessionStatus } from '@/src/opencode/types';
import type { ThinkingLevel } from '@/src/ux/tui-actions';

export interface PromptFooterChip {
  id: 'agent' | 'model' | 'mode' | 'thinking' | 'status' | 'tokens' | 'cost';
  label: string;
  detail?: string;
}

export interface PromptUsageMetadata {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export function createPromptFooterModel({
  agentName,
  agentModel,
  promptMode,
  thinkingLevel,
  status,
  usage,
}: {
  agentName: string | null | undefined;
  agentModel?: ModelLike;
  promptMode: 'ask' | 'shell';
  thinkingLevel: ThinkingLevel;
  status?: SessionStatus;
  usage?: PromptUsageMetadata;
}) {
  const chips: PromptFooterChip[] = [{ id: 'agent', label: agentName ?? 'Agent' }];
  const modelChip = parseModelChip(agentModel);
  if (modelChip) chips.push(modelChip);
  chips.push({ id: 'mode', label: promptMode });
  chips.push({ id: 'thinking', label: `thinking ${thinkingLevel}` });
  const usageChips = usage ? usageToChips(usage) : [];
  chips.push(...usageChips);
  if (status) chips.push({ id: 'status', label: statusLabel(status) });
  return { chips };
}

function parseModelChip(model: ModelLike): PromptFooterChip | null {
  const display = formatModelDisplay(model);
  return display ? { id: 'model', ...display } : null;
}

function statusLabel(status: SessionStatus) {
  if ('type' in status) {
    if (status.type === 'busy') return 'running';
    if (status.type === 'retry') return 'retrying';
    return 'idle';
  }
  return status.running ? 'running' : 'idle';
}

function usageToChips(usage: PromptUsageMetadata) {
  const chips: PromptFooterChip[] = [];
  const totalTokens = usage.totalTokens ?? sumTokenCounts(usage.inputTokens, usage.outputTokens);
  if (typeof totalTokens === 'number') {
    chips.push({ id: 'tokens', label: `${totalTokens.toLocaleString('en-US')} tokens` });
  }
  if (typeof usage.costUsd === 'number') {
    chips.push({ id: 'cost', label: `$${usage.costUsd.toFixed(4)}` });
  }
  return chips;
}

function sumTokenCounts(inputTokens: number | undefined, outputTokens: number | undefined) {
  if (typeof inputTokens !== 'number' && typeof outputTokens !== 'number') return undefined;
  return (inputTokens ?? 0) + (outputTokens ?? 0);
}
