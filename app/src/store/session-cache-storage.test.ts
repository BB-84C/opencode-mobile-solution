import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageWithParts, ProjectGroup, Session } from '@/src/opencode/types';

const asyncStorageBacking = new Map<string, string>();
const asyncStorage = {
  getItem: vi.fn((key: string) => Promise.resolve(asyncStorageBacking.get(key) ?? null)),
  setItem: vi.fn((key: string, value: string) => {
    asyncStorageBacking.set(key, value);
    return Promise.resolve();
  }),
  removeItem: vi.fn((key: string) => {
    asyncStorageBacking.delete(key);
    return Promise.resolve();
  }),
};

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorage,
}));

describe('session cache storage', () => {
  beforeEach(() => {
    asyncStorageBacking.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('persists non-secret workbench and transcript cache', async () => {
    const { loadSessionCache, saveHostSessionCache, saveQueuedPromptsCache, saveSessionTranscriptCache } = await import(
      './session-cache-storage'
    );
    const sessions: Session[] = [{ id: 's1', title: 'Cached session', directory: 'D:/repo' }];
    const projects: ProjectGroup[] = [{ name: 'repo', directory: 'D:/repo', sessionCount: 1 }];
    const messages: MessageWithParts[] = [
      { info: { id: 'm1', role: 'user', sessionID: 's1' }, parts: [{ type: 'text', text: 'cached prompt' }] },
    ];

    await saveHostSessionCache('host-a', {
      sessions,
      projects,
      sessionStatuses: { s1: { type: 'idle' } },
      agents: [{ name: 'orchestrator', model: 'openai/gpt-5' }],
      commands: [{ name: 'share' }],
    });
    await saveSessionTranscriptCache('s1', {
      messages,
      diffs: [{ path: 'src/app.ts', hunks: [] }],
      todos: [{ content: 'Review cache', status: 'pending', priority: 'high' }],
      context: [{ type: 'user' }],
      lspStatus: [{ id: 'tsserver' }],
      mcpStatus: { playwright: { status: 'connected' } },
    });
    await saveQueuedPromptsCache([
      {
        id: 'q1',
        connectionId: 'host-a',
        sessionId: 's1',
        text: 'retry later',
        promptMode: 'ask',
        agent: 'orchestrator',
        model: { providerID: 'openai', modelID: 'gpt-5' },
        variant: 'high',
        createdAt: '2026-07-09T12:00:00.000Z',
      },
    ]);

    await expect(loadSessionCache()).resolves.toEqual({
      sessions: { 'host-a': sessions },
      projects: { 'host-a': projects },
      sessionStatuses: { 'host-a': { s1: { type: 'idle' } } },
      agents: { 'host-a': [{ name: 'orchestrator', model: 'openai/gpt-5' }] },
      commands: { 'host-a': [{ name: 'share' }] },
      messages: { s1: messages },
      diffs: { s1: [{ path: 'src/app.ts', hunks: [] }] },
      todos: { s1: [{ content: 'Review cache', status: 'pending', priority: 'high' }] },
      sessionContexts: { s1: [{ type: 'user' }] },
      lspStatuses: { s1: [{ id: 'tsserver' }] },
      mcpStatuses: { s1: { playwright: { status: 'connected' } } },
      queuedPrompts: [
        {
          id: 'q1',
          connectionId: 'host-a',
          sessionId: 's1',
          text: 'retry later',
          promptMode: 'ask',
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'gpt-5' },
          variant: 'high',
          createdAt: '2026-07-09T12:00:00.000Z',
        },
      ],
    });

    const stored = asyncStorageBacking.get('opencode-mobile.sessionCache.v1') ?? '';
    expect(stored).not.toContain('secret-token');
    expect(asyncStorage.setItem).toHaveBeenCalledWith('opencode-mobile.sessionCache.v1', expect.any(String));
  });

  it('returns an empty cache when persisted data is missing or corrupt', async () => {
    const { loadSessionCache } = await import('./session-cache-storage');
    await expect(loadSessionCache()).resolves.toEqual({
      sessions: {},
      projects: {},
      sessionStatuses: {},
      agents: {},
      commands: {},
      messages: {},
      diffs: {},
      todos: {},
      sessionContexts: {},
      lspStatuses: {},
      mcpStatuses: {},
      queuedPrompts: [],
    });

    asyncStorageBacking.set('opencode-mobile.sessionCache.v1', '{');
    await expect(loadSessionCache()).resolves.toEqual({
      sessions: {},
      projects: {},
      sessionStatuses: {},
      agents: {},
      commands: {},
      messages: {},
      diffs: {},
      todos: {},
      sessionContexts: {},
      lspStatuses: {},
      mcpStatuses: {},
      queuedPrompts: [],
    });
  });
});
