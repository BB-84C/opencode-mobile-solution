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

const SESSION_CACHE_KEY = 'opencode-mobile.sessionCache.v2';
const LEGACY_SESSION_CACHE_KEY = 'opencode-mobile.sessionCache.v1';

export const MAX_CACHED_SESSIONS_PER_HOST = 1_000;
export const MAX_CACHED_TRANSCRIPTS = 8;
export const MAX_CACHED_TRANSCRIPT_MESSAGES = 100;
export const MAX_CACHED_TRANSCRIPT_JSON_CHARS = 1_000_000;
const MAX_CACHED_AUXILIARY_JSON_CHARS = 250_000;

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
  // v1 stored every session and complete transcript in one value. A real
  // device accumulated a 174 MB entry, so even reading it long enough to
  // inspect or migrate would reproduce the launch-time memory kill. Cache is
  // non-authoritative: delete it natively and start with the bounded v2 key.
  await AsyncStorage.removeItem(LEGACY_SESSION_CACHE_KEY).catch(() => undefined);
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
  snapshot.sessions[hostId] = cache.sessions.slice(0, MAX_CACHED_SESSIONS_PER_HOST);
  snapshot.projects[hostId] = cache.projects.slice(0, MAX_CACHED_SESSIONS_PER_HOST);
  snapshot.sessionStatuses[hostId] = Object.fromEntries(
    Object.entries(cache.sessionStatuses).slice(0, MAX_CACHED_SESSIONS_PER_HOST),
  );
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
  snapshot.messages[sessionId] = selectCacheableTranscript(cache.messages);
  snapshot.diffs[sessionId] = boundedJsonValue(cache.diffs, []);
  snapshot.todos[sessionId] = boundedJsonValue(cache.todos, []);
  snapshot.sessionContexts[sessionId] = boundedJsonValue(cache.context, []);
  snapshot.lspStatuses[sessionId] = boundedJsonValue(cache.lspStatus, []);
  snapshot.mcpStatuses[sessionId] = boundedJsonValue(cache.mcpStatus, {});
  retainRecentTranscripts(snapshot, sessionId);
  await saveSessionCache(snapshot);
}

export function selectCacheableTranscript(messages: readonly MessageWithParts[]) {
  const selected: MessageWithParts[] = [];
  let jsonChars = 2;

  for (let index = messages.length - 1; index >= 0 && selected.length < MAX_CACHED_TRANSCRIPT_MESSAGES; index -= 1) {
    const message = messages[index];
    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch {
      continue;
    }
    const nextChars = serialized.length + (selected.length > 0 ? 1 : 0);
    if (nextChars > MAX_CACHED_TRANSCRIPT_JSON_CHARS) continue;
    if (jsonChars + nextChars > MAX_CACHED_TRANSCRIPT_JSON_CHARS) break;
    selected.unshift(message);
    jsonChars += nextChars;
  }

  return selected;
}

function saveSessionCache(snapshot: SessionCacheSnapshot) {
  return AsyncStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(snapshot));
}

function retainRecentTranscripts(snapshot: SessionCacheSnapshot, currentKey: string) {
  const previousKeys = Object.keys(snapshot.messages).filter((key) => key !== currentKey);
  const keep = new Set([...previousKeys.slice(-(MAX_CACHED_TRANSCRIPTS - 1)), currentKey]);
  for (const record of [
    snapshot.messages,
    snapshot.diffs,
    snapshot.todos,
    snapshot.sessionContexts,
    snapshot.lspStatuses,
    snapshot.mcpStatuses,
  ]) {
    for (const key of Object.keys(record)) {
      if (!keep.has(key)) delete record[key];
    }
  }
}

function boundedJsonValue<T>(value: T, fallback: T): T {
  try {
    return JSON.stringify(value).length <= MAX_CACHED_AUXILIARY_JSON_CHARS ? value : fallback;
  } catch {
    return fallback;
  }
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
