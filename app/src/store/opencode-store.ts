import { createStore } from 'zustand/vanilla';

import { OpenCodeClient, type OpenCodeClientLike } from '@/src/opencode/client';
import type { HostConnection, ProjectGroup, Session, SessionStatus } from '@/src/opencode/types';

export interface OpenCodeStoreState {
  connections: HostConnection[];
  activeConnectionId: string | null;
  projects: Record<string, ProjectGroup[]>;
  sessions: Record<string, Session[]>;
  sessionStatuses: Record<string, Record<string, SessionStatus>>;
  interruptArmedAt: Record<string, number>;
  addConnection(connection: HostConnection): void;
  setActiveConnection(connectionId: string): void;
  loadSessions(connectionId: string): Promise<void>;
  requestInterrupt(connectionId: string, sessionId: string): Promise<'armed' | 'interrupted'>;
}

export interface OpenCodeStoreDeps {
  clientFactory?: (connection: HostConnection) => OpenCodeClientLike;
  now?: () => number;
}

const INTERRUPT_ARM_WINDOW_MS = 5_000;

export function createOpenCodeStore(deps: OpenCodeStoreDeps = {}) {
  const now = deps.now ?? Date.now;
  const clientFactory = deps.clientFactory ?? ((connection: HostConnection) => new OpenCodeClient(connection));

  return createStore<OpenCodeStoreState>((set, get) => ({
    connections: [],
    activeConnectionId: null,
    projects: {},
    sessions: {},
    sessionStatuses: {},
    interruptArmedAt: {},

    addConnection(connection) {
      set((state) => {
        const existing = state.connections.filter((item) => item.id !== connection.id);
        return {
          connections: [...existing, connection],
          activeConnectionId: state.activeConnectionId,
        };
      });
    },

    setActiveConnection(connectionId) {
      set({ activeConnectionId: connectionId });
    },

    async loadSessions(connectionId) {
      const connection = get().connections.find((item) => item.id === connectionId);
      if (!connection) throw new Error(`Connection not found: ${connectionId}`);

      const client = clientFactory(connection);
      const [sessions, statuses] = await Promise.all([client.listSessions(), client.getSessionStatus()]);

      set((state) => ({
        sessions: { ...state.sessions, [connectionId]: sessions },
        sessionStatuses: { ...state.sessionStatuses, [connectionId]: statuses },
        projects: { ...state.projects, [connectionId]: groupSessionsByDirectory(sessions) },
      }));
    },

    async requestInterrupt(connectionId, sessionId) {
      const key = `${connectionId}:${sessionId}`;
      const armedAt = get().interruptArmedAt[key] ?? 0;
      const current = now();

      if (!armedAt || current - armedAt > INTERRUPT_ARM_WINDOW_MS) {
        set((state) => ({ interruptArmedAt: { ...state.interruptArmedAt, [key]: current } }));
        return 'armed';
      }

      const connection = get().connections.find((item) => item.id === connectionId);
      if (!connection) throw new Error(`Connection not found: ${connectionId}`);
      await clientFactory(connection).abortSession(sessionId);
      set((state) => {
        const next = { ...state.interruptArmedAt };
        delete next[key];
        return { interruptArmedAt: next };
      });
      return 'interrupted';
    },
  }));
}

export function groupSessionsByDirectory(sessions: Session[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    if (!session.directory || session.parentID) continue;
    const id = session.relayTargetID ? `${session.relayTargetID}:${session.directory}` : session.directory;
    const existing = groups.get(id);
    groups.set(id, {
      ...(session.relayTargetID ? { id, relayTargetID: session.relayTargetID } : {}),
      ...(session.relayTargetName ? { relayTargetName: session.relayTargetName } : {}),
      directory: session.directory,
      sessionCount: (existing?.sessionCount ?? 0) + 1,
      name: projectNameFromDirectory(session.directory),
    });
  }
  return [...groups.values()].sort((a, b) =>
    `${a.relayTargetName ?? ''}\0${a.directory}`.localeCompare(`${b.relayTargetName ?? ''}\0${b.directory}`),
  );
}

function projectNameFromDirectory(directory: string) {
  const normalized = directory.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts.at(-1) || normalized;
}
