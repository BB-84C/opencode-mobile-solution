import type {
  FileDiff,
  HostConnection,
  LspStatus,
  McpStatusMap,
  MessageWithParts,
  Session,
  SessionContextMessage,
  SessionStatus,
  TodoItem,
} from '@/src/opencode/types';

export interface SessionDrawerInput {
  host?: HostConnection;
  session?: Session;
  status?: SessionStatus;
  diffs: FileDiff[];
  messages: MessageWithParts[];
  contextMessages?: SessionContextMessage[];
  todos?: TodoItem[];
  lspStatus?: LspStatus[];
  mcpStatus?: McpStatusMap;
}

export function createSessionDrawerModel(input: SessionDrawerInput) {
  const subagentCount = input.messages.reduce((count, message) => count + countSubagentParts(message), 0);
  const changedFiles = input.diffs.length;
  const todos = input.todos ?? [];
  return {
    hiddenByDefault: true,
    sections: [
      {
        id: 'session',
        label: input.session?.title || input.session?.id || 'Session',
        detail: input.session?.id,
      },
      {
        id: 'workspace',
        label: 'Workspace',
        detail: input.session?.directory || input.session?.path || 'Unknown workspace',
      },
      {
        id: 'share',
        label: 'Share URL',
        detail: shareUrl(input.session) ?? 'Not shared - use Commands > Share session',
      },
      {
        id: 'status',
        label: 'Status',
        detail: statusLabel(input.status),
      },
      {
        id: 'lsp-mcp',
        label: 'LSP / MCP',
        detail: lspMcpSummary(input.lspStatus, input.mcpStatus),
      },
      {
        id: 'context',
        label: 'Context',
        detail: contextSummary(input.contextMessages, input.messages.length),
      },
      {
        id: 'todos',
        label: 'Todos',
        detail: todoSummary(todos),
      },
      {
        id: 'files',
        label: 'Files',
        detail: `${changedFiles} changed file${changedFiles === 1 ? '' : 's'}`,
      },
      {
        id: 'subagents',
        label: 'Subagents',
        detail: `${subagentCount} subagent transcript${subagentCount === 1 ? '' : 's'}`,
      },
    ],
  };
}

function shareUrl(session: Session | undefined) {
  return session?.share?.url ?? session?.shareUrl ?? session?.shareURL;
}

function lspMcpSummary(lspStatus: LspStatus[] | undefined, mcpStatus: McpStatusMap | undefined) {
  if (!lspStatus || !mcpStatus) return 'Status unavailable';
  const mcpEntries = Object.values(mcpStatus);
  const connectedMcp = mcpEntries.filter((entry) => entry.status === 'connected').length;
  return `${lspStatus.length} LSP / ${connectedMcp} of ${mcpEntries.length} MCP connected`;
}

function contextSummary(contextMessages: SessionContextMessage[] | undefined, transcriptCount: number) {
  if (!contextMessages) return `${transcriptCount} transcript message${transcriptCount === 1 ? '' : 's'}`;
  return `${contextMessages.length} active context message${contextMessages.length === 1 ? '' : 's'}`;
}

function todoSummary(todos: TodoItem[]) {
  if (todos.length === 0) return 'No todos';
  const done = todos.filter((todo) => todo.status === 'completed' || todo.status === 'cancelled').length;
  const open = todos.length - done;
  return `${open} open / ${done} done`;
}

function statusLabel(status: SessionStatus | undefined) {
  if (!status) return 'idle';
  if ('type' in status) {
    if (status.type === 'busy') return 'running';
    if (status.type === 'retry') return 'retry';
    return status.type;
  }
  return status.running ? 'running' : 'idle';
}

function countSubagentParts(message: MessageWithParts) {
  return message.parts.filter((part) => {
    const record = part as Record<string, unknown>;
    const tool = typeof record.tool === 'string' ? record.tool.toLowerCase() : '';
    const state = typeof record.state === 'object' && record.state ? (record.state as Record<string, unknown>) : undefined;
    const metadata =
      state && typeof state.metadata === 'object' && state.metadata
        ? (state.metadata as Record<string, unknown>)
        : undefined;
    return tool === 'task' || typeof metadata?.sessionId === 'string';
  }).length;
}
