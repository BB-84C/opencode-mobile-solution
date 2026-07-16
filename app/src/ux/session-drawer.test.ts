import { describe, expect, it } from 'vitest';

import { createSessionDrawerModel } from './session-drawer';
import type { FileDiff, HostConnection, MessageWithParts, Session, SessionStatus } from '@/src/opencode/types';

const host: HostConnection = {
  id: 'host-1',
  name: 'Example Relay',
  url: 'https://opencode.example.com',
  authType: 'bearer',
  lastConnected: null,
  isReachable: true,
};

const session: Session = {
  id: 's1',
  title: 'Archive task',
  directory: 'D:\\workspace\\project',
};

const diffs: FileDiff[] = [{ path: 'src/archive.ts', hunks: [] }];

const messages: MessageWithParts[] = [
  {
    info: { id: 'm1', role: 'assistant' },
    parts: [{ type: 'tool', tool: 'task', state: { metadata: { sessionId: 'child-1' } } }],
  },
];

describe('createSessionDrawerModel', () => {
  it('maps the TUI sidebar to a mobile overflow drawer', () => {
    const model = createSessionDrawerModel({
      host,
      session,
      status: { type: 'busy' } satisfies SessionStatus,
      diffs,
      messages,
      contextMessages: [{ type: 'user' }, { type: 'assistant' }, { type: 'compaction' }],
      lspStatus: [{ id: 'tsserver', status: 'running' }],
      mcpStatus: { playwright: { status: 'connected' }, grep_app: { status: 'disconnected' } },
      todos: [
        { content: 'Review transcript', status: 'pending', priority: 'high' },
        { content: 'Ship drawer', status: 'completed', priority: 'medium' },
      ],
    });

    expect(model.hiddenByDefault).toBe(true);
    expect(model.sections.map((section) => section.id)).toEqual([
      'session',
      'workspace',
      'share',
      'status',
      'lsp-mcp',
      'context',
      'todos',
      'files',
      'subagents',
    ]);
    expect(model.sections.find((section) => section.id === 'status')?.detail).toBe('running');
    expect(model.sections.find((section) => section.id === 'share')?.detail).toBe('Not shared - use Commands > Share session');
    expect(model.sections.find((section) => section.id === 'lsp-mcp')?.detail).toBe('1 LSP / 1 of 2 MCP connected');
    expect(model.sections.find((section) => section.id === 'context')?.detail).toBe('3 active context messages');
    expect(model.sections.find((section) => section.id === 'todos')?.detail).toBe('1 open / 1 done');
    expect(model.sections.find((section) => section.id === 'files')?.detail).toBe('1 changed file');
    expect(model.sections.find((section) => section.id === 'subagents')?.detail).toBe('1 subagent transcript');
  });

  it('shows an explicit empty todo state when the live todo list is empty', () => {
    const model = createSessionDrawerModel({
      host,
      session,
      diffs: [],
      messages: [],
      todos: [],
    });

    expect(model.sections.find((section) => section.id === 'todos')?.detail).toBe('No todos');
  });

  it('shows only explicit share URLs returned by the session API', () => {
    const model = createSessionDrawerModel({
      host,
      session: { ...session, share: { url: 'https://opencode.example.com/share/s1' } },
      diffs: [],
      messages: [],
    });

    expect(model.sections.find((section) => section.id === 'share')?.detail).toBe('https://opencode.example.com/share/s1');
  });

  it('falls back to transcript count when active context is unavailable', () => {
    const model = createSessionDrawerModel({
      host,
      session,
      diffs: [],
      messages,
    });

    expect(model.sections.find((section) => section.id === 'context')?.detail).toBe('1 transcript message');
  });
});
