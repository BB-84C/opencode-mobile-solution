import type { SessionStatus, ToolPart } from '@/src/opencode/types';

export type SubagentStatus = 'running' | 'completed' | 'retry';

export interface SubagentCardModel {
  title: string;
  sessionId?: string;
  status: SubagentStatus;
  detailLines: string[];
  action:
    | { type: 'navigate'; label: 'Open transcript'; sessionId: string }
    | { type: 'disabled'; label: 'Transcript unavailable'; detail: string };
}

export function createSubagentCardModel(
  part: ToolPart,
  options: { statuses?: Record<string, SessionStatus> } = {},
): SubagentCardModel | null {
  const metadata = mergeRecords(recordValue(part.state), recordValue(recordValue(part.state)?.metadata), recordValue(part.metadata));
  const sessionId = firstString(metadata, ['sessionId', 'sessionID', 'childSessionId', 'childSessionID']);
  const isSubagent = normalizedTool(part.tool) === 'task' || Boolean(sessionId);
  if (!isSubagent) return null;

  const status = subagentStatus(metadata, sessionId ? options.statuses?.[sessionId] : undefined);
  const detailLines = [`Status ${status}`];
  const toolCallCount = numberValue(firstValue(metadata, ['toolCallCount', 'toolCalls', 'tools', 'callCount']));
  if (toolCallCount !== undefined) detailLines.push(`${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}`);
  const elapsedMs = elapsedFromStateTime(recordValue(recordValue(part.state)?.time)) ?? firstElapsedMilliseconds(metadata);
  if (elapsedMs !== undefined) detailLines.push(`Elapsed ${formatElapsed(elapsedMs)}`);

  return {
    title: 'Subagent task',
    sessionId,
    status,
    detailLines,
    action: sessionId
      ? { type: 'navigate', label: 'Open transcript', sessionId }
      : {
          type: 'disabled',
          label: 'Transcript unavailable',
          detail: 'Child session metadata is missing from this task part',
        },
  };
}

function subagentStatus(metadata: Record<string, unknown>, status?: SessionStatus): SubagentStatus {
  const fromMetadata = firstString(metadata, ['status', 'state', 'phase']);
  if (fromMetadata) {
    const normalized = fromMetadata.toLowerCase();
    if (['retry', 'retrying'].includes(normalized)) return 'retry';
    if (['completed', 'complete', 'done', 'success', 'succeeded', 'idle'].includes(normalized)) return 'completed';
    if (['running', 'busy', 'pending', 'started', 'in_progress'].includes(normalized)) return 'running';
  }

  if (status) {
    if ('type' in status) {
      if (status.type === 'busy') return 'running';
      if (status.type === 'retry') return 'retry';
      return 'completed';
    }
    return status.running ? 'running' : 'completed';
  }

  return 'running';
}

function formatElapsed(milliseconds: number) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${Number(seconds.toFixed(seconds < 10 ? 1 : 0))}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function firstElapsedMilliseconds(source: Record<string, unknown>) {
  const milliseconds = numberValue(firstValue(source, ['elapsedMs', 'durationMs']));
  if (milliseconds !== undefined) return milliseconds;
  const seconds = numberValue(firstValue(source, ['elapsed', 'durationSeconds']));
  return seconds === undefined ? undefined : seconds * 1_000;
}

function elapsedFromStateTime(time: Record<string, unknown> | undefined) {
  if (!time) return undefined;
  const start = numberValue(time.start);
  const end = numberValue(time.end);
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

function numberValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return undefined;
}

function firstString(source: Record<string, unknown>, keys: string[]) {
  const value = firstValue(source, keys);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function firstValue(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

function normalizedTool(tool: unknown) {
  return typeof tool === 'string' ? tool.toLowerCase() : undefined;
}

function mergeRecords(...records: Array<Record<string, unknown> | undefined>) {
  return Object.assign({}, ...records.filter(Boolean));
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
