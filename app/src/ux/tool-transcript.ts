import type { MessagePart, ToolPart } from '@/src/opencode/types';

const hiddenPartTypes = new Set(['step-start', 'step-finish', 'snapshot', 'patch']);
const semanticPartTypes = new Set(['text', 'reasoning', 'tool', 'tool_use', 'tool_result', 'file', 'compaction', 'error']);
const terminalControlPattern = new RegExp([
  '[\\u001B\\u009B][[\\]\\()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
  '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
].join('|'), 'g');

const toolLabels: Record<string, string> = {
  apply_patch: 'Apply patch',
  applypatch: 'Apply patch',
  bash: 'Bash',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  question: 'Question',
  read: 'Read',
  skill: 'Skill',
  task: 'Subagent task',
  todo: 'Update todos',
  todowrite: 'Update todos',
  webfetch: 'Web fetch',
  websearch: 'Web search',
  write: 'Write',
};

export function shouldRenderTranscriptPart(part: MessagePart) {
  if (hiddenPartTypes.has(part.type)) return false;
  return semanticPartTypes.has(part.type);
}

export function createToolTranscriptModel(part: ToolPart) {
  const record = part as Record<string, unknown>;
  const state = recordValue(record.state);
  const input = recordValue(state?.input) ?? recordValue(record.input);
  const tool = normalizeToolName(stringValue(record.tool) ?? stringValue(record.name) ?? 'tool');
  const status = stringValue(state?.status) ?? stringValue(record.status) ?? 'pending';
  const shell = tool === 'bash' || tool === 'execute'
    ? shellTranscriptModel(input, record, state)
    : undefined;
  const visibleText = shell
    ? joinVisible([shell.command, shell.output], statusText(status, tool))
    : semanticToolText(tool, status, input, record, state);
  return {
    title: toolLabels[tool] ?? titleCase(tool),
    visibleText,
    rawText: JSON.stringify(part, null, 2),
    status,
    shell,
  };
}

export function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  const lines = output.split('\n');
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) {
    return { output, overflow: false };
  }

  const preview = lines.slice(0, maxLines).join('\n');
  if (Array.from(preview).length > maxChars) {
    return {
      output: `${Array.from(preview).slice(0, Math.max(0, maxChars - 1)).join('')}…`,
      overflow: true,
    };
  }

  return { output: [...lines.slice(0, maxLines), '…'].join('\n'), overflow: true };
}

export function shellOutputCharacterBudget(contentWidth: number, maxLines = 10) {
  return maxLines * Math.max(20, Math.floor(contentWidth) - 6);
}

function shellTranscriptModel(
  input: Record<string, unknown> | undefined,
  record: Record<string, unknown>,
  state: Record<string, unknown> | undefined,
) {
  const metadata = recordValue(state?.metadata) ?? recordValue(record.metadata);
  const output = outputValue(metadata?.output)
    ?? outputValue(state?.output)
    ?? outputValue(record.output)
    ?? outputValue(state?.result)
    ?? outputValue(record.result)
    ?? '';
  return {
    command: commandFrom(input) ?? stringValue(record.command) ?? stringValue(state?.command) ?? '',
    output: stripTerminalControls(output.trim()),
  };
}

function stripTerminalControls(value: string) {
  terminalControlPattern.lastIndex = 0;
  return value.replace(terminalControlPattern, '');
}

function semanticToolText(
  tool: string,
  status: string,
  input: Record<string, unknown> | undefined,
  record: Record<string, unknown>,
  state: Record<string, unknown> | undefined,
) {
  if (tool === 'bash' || tool === 'execute') {
    return statusText(status, tool);
  }
  if (tool === 'skill') {
    return stringValue(input?.name) ?? stringValue(input?.skill) ?? statusText(status, tool);
  }
  if (tool === 'read' || tool === 'write' || tool === 'edit') {
    return stringValue(input?.filePath) ?? stringValue(input?.path) ?? statusText(status, tool);
  }
  if (tool === 'grep' || tool === 'glob') {
    return joinVisible([stringValue(input?.pattern), stringValue(input?.path)], statusText(status, tool));
  }
  if (tool === 'websearch' || tool === 'web_search') {
    return stringValue(input?.query) ?? statusText(status, tool);
  }
  if (tool === 'webfetch' || tool === 'web_fetch') {
    return stringValue(input?.url) ?? statusText(status, tool);
  }
  if (tool === 'todowrite' || tool === 'todo') {
    const todos = input?.todos;
    return Array.isArray(todos) ? `${todos.length} todo${todos.length === 1 ? '' : 's'} updated` : statusText(status, tool);
  }
  if (tool === 'apply_patch' || tool === 'applypatch') {
    return stringValue(input?.filePath) ?? stringValue(input?.path) ?? statusText(status, tool);
  }
  if (tool === 'question') return status === 'completed' ? 'Question answered' : statusText(status, tool);
  if (tool === 'task') return statusText(status, tool);
  return statusText(status, tool);
}

function joinVisible(values: Array<string | undefined>, fallback: string) {
  const visible = values.filter((value): value is string => Boolean(value?.trim()));
  return visible.length > 0 ? visible.join('\n') : fallback;
}

function statusText(status: string, tool: string) {
  if (status === 'pending') return tool === 'apply_patch' || tool === 'applypatch' ? 'Preparing patch...' : 'Waiting to run...';
  if (status === 'running') return 'Running...';
  if (status === 'completed') return 'Completed';
  if (status === 'error' || status === 'failed') return 'Failed';
  return 'Tool call';
}

function commandFrom(input: Record<string, unknown> | undefined) {
  return stringValue(input?.command) ?? stringValue(input?.cmd) ?? stringValue(input?.pattern) ?? stringValue(input?.filePath);
}

function outputValue(value: unknown) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function normalizeToolName(value: string) {
  return value.replace(/[\s-]/g, '_').toLowerCase();
}

function titleCase(value: string) {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
