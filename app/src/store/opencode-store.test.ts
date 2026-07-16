import { describe, expect, it, vi } from 'vitest';

import { createOpenCodeStore } from './opencode-store';
import type { OpenCodeClientLike } from '@/src/opencode/client';
import type { HostConnection, Session, SessionStatus } from '@/src/opencode/types';

const host: HostConnection = {
  id: 'h1',
  name: 'Example Relay',
  url: 'https://opencode.example.com',
  authType: 'bearer',
  token: 'token',
  lastConnected: null,
  isReachable: false,
};

const sessions: Session[] = [
  { id: 's1', title: 'Archive task', directory: 'D:\\workspace', created: '1', updated: '3' },
  { id: 's2', title: 'Relay', directory: 'D:\\workspace\\project', created: '1', updated: '2' },
  { id: 's3', title: 'Relay subtask', directory: 'D:\\workspace\\project', parentID: 's2', created: '1', updated: '2' },
];

describe('createOpenCodeStore', () => {
  it('keeps added hosts unselected until an explicit selection', () => {
    const store = createOpenCodeStore();

    store.getState().addConnection(host);

    expect(store.getState().connections).toEqual([host]);
    expect(store.getState().activeConnectionId).toBeNull();

    store.getState().setActiveConnection(host.id);
    expect(store.getState().activeConnectionId).toBe(host.id);
  });

  it('loads sessions and groups them by project directory', async () => {
    const client = fakeClient({
      listSessions: vi.fn(async () => sessions),
      getSessionStatus: vi.fn(async () => ({ s1: { type: 'busy' as const } })),
    });
    const store = createOpenCodeStore({ clientFactory: () => client });

    store.getState().addConnection(host);
    await store.getState().loadSessions(host.id);

    expect(store.getState().sessions[host.id]).toEqual(sessions);
    expect(store.getState().projects[host.id]).toEqual([
      { name: 'workspace', directory: 'D:\\workspace', sessionCount: 1 },
      { name: 'project', directory: 'D:\\workspace\\project', sessionCount: 1 },
    ]);
    expect(store.getState().sessionStatuses[host.id].s1).toEqual({ type: 'busy' });
  });

  it('keeps identical directory names on different relay machines as separate workspaces', async () => {
    const duplicatedDirectorySessions: Session[] = [
      {
        id: 'windows-session',
        directory: '/work/project',
        relayTargetID: 'windows',
        relayTargetName: 'Windows workstation',
      },
      {
        id: 'mac-session',
        directory: '/work/project',
        relayTargetID: 'mac',
        relayTargetName: 'MacBook',
      },
    ];
    const client = fakeClient({ listSessions: vi.fn(async () => duplicatedDirectorySessions) });
    const store = createOpenCodeStore({ clientFactory: () => client });
    store.getState().addConnection(host);

    await store.getState().loadSessions(host.id);

    expect(store.getState().projects[host.id]).toEqual([
      {
        id: 'mac:/work/project',
        name: 'project',
        directory: '/work/project',
        sessionCount: 1,
        relayTargetID: 'mac',
        relayTargetName: 'MacBook',
      },
      {
        id: 'windows:/work/project',
        name: 'project',
        directory: '/work/project',
        sessionCount: 1,
        relayTargetID: 'windows',
        relayTargetName: 'Windows workstation',
      },
    ]);
  });

  it('requires a second interrupt tap while a session is running', async () => {
    const abortSession = vi.fn(async () => undefined);
    const store = createOpenCodeStore({
      clientFactory: () => fakeClient({ abortSession }),
      now: (() => {
        let value = 1000;
        return () => value;
      })(),
    });

    store.getState().addConnection(host);
    expect(await store.getState().requestInterrupt(host.id, 's1')).toEqual('armed');
    expect(abortSession).not.toHaveBeenCalled();
    expect(await store.getState().requestInterrupt(host.id, 's1')).toEqual('interrupted');
    expect(abortSession).toHaveBeenCalledWith('s1');
  });
});

function fakeClient(overrides: Partial<OpenCodeClientLike> = {}): OpenCodeClientLike {
  return {
    health: vi.fn(),
    listProjects: vi.fn(),
    listSessions: vi.fn(),
    getSession: vi.fn(),
    updateSession: vi.fn(),
    forkSession: vi.fn(),
    shareSession: vi.fn(),
    compactSession: vi.fn(),
    revertMessage: vi.fn(),
    unrevertSession: vi.fn(),
    getSessionStatus: vi.fn(async () => ({}) as Record<string, SessionStatus>),
    getLspStatus: vi.fn(),
    getMcpStatus: vi.fn(),
    listMessages: vi.fn(),
    listMessagePage: vi.fn(),
    getSessionContext: vi.fn(),
    getSessionTodos: vi.fn(),
    createSession: vi.fn(),
    sendMessage: vi.fn(),
    sendAsync: vi.fn(),
    sendCommand: vi.fn(),
    runShell: vi.fn(),
    abortSession: vi.fn(),
    listAgents: vi.fn(),
    listCommands: vi.fn(),
    findFiles: vi.fn(),
    getSessionDiff: vi.fn(),
    respondToPermission: vi.fn(),
    listQuestions: vi.fn(),
    respondToQuestion: vi.fn(),
    rejectQuestion: vi.fn(),
    ...overrides,
  };
}
