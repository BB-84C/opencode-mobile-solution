import AsyncStorage from '@react-native-async-storage/async-storage';

import type {
  Agent,
  Command,
  FileDiff,
  LspStatus,
  McpStatusMap,
  MessageWithParts,
  ProjectGroup,
  QueuedPrompt,
  Session,
  SessionContextMessage,
  SessionStatus,
  TodoItem,
} from '@/src/opencode/types';

const SESSION_CACHE_KEY = 'opencode-mobile.sessionCache.v1';

export interface SessionCacheSnapshot {
  sessions: Record<string, Session[]>;
  projects: Record<string, ProjectGroup[]>;
  sessionStatuses: Record<string, Record<string, SessionStatus>>;
  agents: Record<string, Agent[]>;
  commands: Record<string, Command[]>;
  messages: Record<string, MessageWithParts[]>;
  diffs: Record<string, FileDiff[]>;
  todos: Record<string, TodoItem[]>;
  sessionContexts: Record<string, SessionContextMessage[]>;
  lspStatuses: Record<string, LspStatus[]>;
  mcpStatuses: Record<string, McpStatusMap>;
  queuedPrompts: QueuedPrompt[];
}

export type HostSessionCache = Pick<SessionCacheSnapshot, 'sessions' | 'projects' | 'sessionStatuses' | 'agents' | 'commands'>;
export type SessionTranscriptCache = {
  messages: MessageWithParts[];
  diffs: FileDiff[];
  todos: TodoItem[];
  context: SessionContextMessage[];
  lspStatus: LspStatus[];
  mcpStatus: McpStatusMap;
};

export async function loadSessionCache(): Promise<SessionCacheSnapshot> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_CACHE_KEY);
    if (!raw) return emptySessionCache();
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return emptySessionCache();
    return {
      sessions: recordOrEmpty(parsed.sessions),
      projects: recordOrEmpty(parsed.projects),
      sessionStatuses: recordOrEmpty(parsed.sessionStatuses),
      agents: recordOrEmpty(parsed.agents),
      commands: recordOrEmpty(parsed.commands),
      messages: recordOrEmpty(parsed.messages),
      diffs: recordOrEmpty(parsed.diffs),
      todos: recordOrEmpty(parsed.todos),
      sessionContexts: recordOrEmpty(parsed.sessionContexts),
      lspStatuses: recordOrEmpty(parsed.lspStatuses),
      mcpStatuses: recordOrEmpty(parsed.mcpStatuses),
      queuedPrompts: Array.isArray(parsed.queuedPrompts) ? (parsed.queuedPrompts as QueuedPrompt[]) : [],
    } as SessionCacheSnapshot;
  } catch {
    return emptySessionCache();
  }
}

export async function saveHostSessionCache(
  hostId: string,
  cache: {
    sessions: Session[];
    projects: ProjectGroup[];
    sessionStatuses: Record<string, SessionStatus>;
    agents: Agent[];
    commands: Command[];
  },
) {
  const snapshot = await loadSessionCache();
  snapshot.sessions[hostId] = cache.sessions;
  snapshot.projects[hostId] = cache.projects;
  snapshot.sessionStatuses[hostId] = cache.sessionStatuses;
  snapshot.agents[hostId] = cache.agents;
  snapshot.commands[hostId] = cache.commands;
  await saveSessionCache(snapshot);
}

export async function saveQueuedPromptsCache(queuedPrompts: QueuedPrompt[]) {
  const snapshot = await loadSessionCache();
  snapshot.queuedPrompts = queuedPrompts;
  await saveSessionCache(snapshot);
}

export async function saveSessionTranscriptCache(sessionId: string, cache: SessionTranscriptCache) {
  const snapshot = await loadSessionCache();
  snapshot.messages[sessionId] = cache.messages;
  snapshot.diffs[sessionId] = cache.diffs;
  snapshot.todos[sessionId] = cache.todos;
  snapshot.sessionContexts[sessionId] = cache.context;
  snapshot.lspStatuses[sessionId] = cache.lspStatus;
  snapshot.mcpStatuses[sessionId] = cache.mcpStatus;
  await saveSessionCache(snapshot);
}

function saveSessionCache(snapshot: SessionCacheSnapshot) {
  return AsyncStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(snapshot));
}

function emptySessionCache(): SessionCacheSnapshot {
  return {
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
  };
}

function recordOrEmpty(value: unknown) {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
