import { create } from 'zustand';

import {
  compareSessionsByRecency,
  DEFAULT_MESSAGE_PAGE_LIMIT,
  OpenCodeClient,
  OpenCodeRequestError,
  type RequestPolicy,
} from '@/src/opencode/client';
import {
  flattenConfiguredModels,
  resolvePromptSelection,
  variantsForModel,
} from '@/src/opencode/execution-contract';
import type { ServerEvent } from '@/src/opencode/sse';
import type {
  Agent,
  Command,
  ConfiguredProvidersResponse,
  FileDiff,
  FileReference,
  HealthResponse,
  HostConnection,
  LspStatus,
  MachineExecutionContract,
  MachineExecutionContractLoadState,
  McpStatusMap,
  MessagePart,
  MessageWithParts,
  ModelRef,
  PermissionRequest,
  PromptDispatchOptions,
  PromptSelection,
  ProjectGroup,
  QuestionRequest,
  QueuedPrompt,
  RelayDeviceIdentity,
  RelayTarget,
  RelayTargetState,
  Session,
  SessionContextMessage,
  SessionStatus,
  SessionTransportState,
  TodoItem,
} from '@/src/opencode/types';
import { groupSessionsByDirectory } from '@/src/store/opencode-store';
import {
  createPermissionReply,
  createQuestionReplyBody,
  type PermissionActionId,
  type QuestionPromptPayload,
} from '@/src/ux/session-interactions';
import type { QuestionSubmission } from '@/src/ux/question-request';
import { sortMessagesChronologically } from '@/src/ux/message-order';
import type { ThinkingLevel } from '@/src/ux/tui-actions';
import { sessionKey, type SessionRef } from '@/src/ux/session-forest';

export type { SessionRef } from '@/src/ux/session-forest';

import {
  loadActiveConnectionId,
  loadConnections,
  removeConnectionSecrets,
  saveActiveConnectionId,
  saveConnections,
} from './connection-storage';
import {
  loadSessionCache,
  saveHostSessionCache,
  saveQueuedPromptsCache,
  saveSessionTranscriptCache,
  type SessionCacheSnapshot,
} from './session-cache-storage';
import { loadPromptPreferences, savePromptPreferences } from './prompt-preferences-storage';
import { createPersistenceCoordinator } from './persistence-coordinator';

export type LoadingState = 'idle' | 'loading' | 'error';
export type PromptMode = 'ask' | 'shell';

/**
 * A session ID is only unique inside one relay machine. Every API that can
 * read or mutate a session therefore takes the complete routing identity.
 */
export type SessionInput = SessionRef | string;

export const DIRECT_RELAY_TARGET_ID = '__opencode_direct__';

/** Collision-free, stable key used by every per-session state map. */
export function sessionStateKey(ref: SessionRef): string {
  return sessionKey(ref);
}

export function decodeSessionStateKey(key: string): SessionRef | undefined {
  try {
    const value = JSON.parse(key) as unknown;
    if (
      Array.isArray(value)
      && value.length === 3
      && value.every((item) => typeof item === 'string' && item.length > 0)
    ) {
      return { connectionId: value[0], relayTargetID: value[1], sessionId: value[2] };
    }
  } catch {
    // A pre-composite cache used a bare session ID. Migration handles it only
    // when that ID resolves to exactly one machine.
  }
  return undefined;
}

export function sessionRefFor(connectionId: string, session: Session): SessionRef {
  return {
    connectionId,
    relayTargetID: session.relayTargetID ?? DIRECT_RELAY_TARGET_ID,
    sessionId: session.id,
  };
}

export function executionScopeKey(ref: Pick<SessionRef, 'connectionId' | 'relayTargetID'>, directory?: string): string {
  return JSON.stringify([ref.connectionId, ref.relayTargetID, directory ?? '']);
}

export interface MobileStore {
  connections: HostConnection[];
  activeConnectionId: string | null;
  activeSessionRef: SessionRef | null;
  activeSessionKey: string | null;
  /** Transitional display-only compatibility field. Never use it for routing. */
  activeSessionId: string | null;
  hydrated: boolean;
  projects: Record<string, ProjectGroup[]>;
  sessions: Record<string, Session[]>;
  relayTargets: Record<string, RelayTargetState[]>;
  sessionStatuses: Record<string, SessionStatus>;
  messages: Record<string, MessageWithParts[]>;
  messageNextCursors: Record<string, string | null>;
  olderMessageLoadStates: Record<string, LoadingState>;
  olderMessageErrors: Record<string, string | null>;
  sessionContexts: Record<string, SessionContextMessage[]>;
  todos: Record<string, TodoItem[]>;
  lspStatuses: Record<string, LspStatus[]>;
  mcpStatuses: Record<string, McpStatusMap>;
  agents: Record<string, Agent[]>;
  commands: Record<string, Command[]>;
  machineContracts: Record<string, MachineExecutionContract>;
  contractLoadStates: Record<string, MachineExecutionContractLoadState>;
  sessionSelections: Record<string, PromptSelection>;
  sessionLoadStates: Record<string, LoadingState>;
  sessionErrors: Record<string, string | null>;
  activeAgentName: string | null;
  activeAgentByHost: Record<string, string>;
  activeVariant?: string;
  questions: Record<string, QuestionRequest[]>;
  permissions: Record<string, PermissionRequest[]>;
  permissionErrors: Record<string, string | null>;
  diffs: Record<string, FileDiff[]>;
  loading: LoadingState;
  error: string | null;
  /** Transient keyboard/action feedback. Kept apart from `error`, which screens
   *  render as a host sync failure. */
  notice: string | null;
  commandPaletteOpen: boolean;
  hostSyncStates: Record<string, LoadingState>;
  hostSyncErrors: Record<string, string | null>;
  hostSyncNotes: Record<string, string | null>;
  interruptArmedAt: Record<string, number>;
  /** Legacy four-level display state; dynamic variants live in sessionSelections. */
  thinkingLevel: ThinkingLevel;
  promptMode: PromptMode;
  promptHistory: string[];
  promptHistoryCursor: number | null;
  stashedPrompts: string[];
  /** Kept only to migrate/delete old unsafe retry records. It is always empty after hydrate. */
  queuedPrompts: QueuedPrompt[];
  eventUnsubscribers: Partial<Record<string, () => void>>;
  eventSubscriptionDirectories: Partial<Record<string, string | undefined>>;
  eventConnected: Record<string, boolean>;
  eventConnectionStates: Record<string, SessionTransportState>;
  questionRevision: number;
  hydrate(): Promise<void>;
  addConnection(input: Omit<HostConnection, 'id' | 'lastConnected' | 'isReachable'>): Promise<void>;
  pairConnection(input: { name: string; url: string; token: string; clientID: string; displayNameRevision?: number }): Promise<string>;
  updateConnection(id: string, input: Omit<HostConnection, 'id' | 'lastConnected' | 'isReachable'>): Promise<void>;
  removeConnection(id: string): Promise<void>;
  setActiveConnection(id: string): boolean;
  clearActiveConnection(): void;
  /** Removes a session on the machine that owns it. Deliberately not bound to
   *  any key: a satellite device should not be one keystroke from deleting work. */
  deleteSession(input: SessionRef | string): Promise<void>;
  showNotice(message: string): void;
  dismissNotice(): void;
  openCommandPalette(): void;
  closeCommandPalette(): void;
  refreshActiveHost(options?: { background?: boolean }): Promise<void>;
  subscribeToActiveHost(): void;
  unsubscribeFromHost(connectionId: string): void;
  openSession(ref: SessionInput): Promise<void>;
  loadOlderMessages(ref: SessionInput): Promise<void>;
  searchFileReferences(query: string, ref?: SessionInput): Promise<FileReference[]>;
  startNewSessionPrompt(): void;
  createSession(input: {
    connectionId: string;
    relayTargetID?: string;
    directory?: string;
    title?: string;
  }): Promise<SessionRef | null>;
  /** Fetches a machine's agents and providers without needing a session there,
   *  so a new-session form has real lists on a fresh install. */
  loadMachineContract(input: {
    connectionId: string;
    relayTargetID?: string;
    directory?: string;
  }): Promise<boolean>;
  sendPrompt(text: string): Promise<string | null>;
  /** Removes legacy records; it never dispatches them. */
  flushQueuedPrompts(connectionId?: string): Promise<void>;
  renameSession(ref: SessionInput, title: string): Promise<void>;
  shareSession(ref: SessionInput): Promise<string | null>;
  forkSession(ref: SessionInput, messageId?: string): Promise<string | null>;
  compactSession(ref: SessionInput): Promise<void>;
  revertMessage(ref: SessionInput, messageId: string): Promise<void>;
  unrevertSession(ref: SessionInput): Promise<void>;
  respondToPermission(ref: SessionInput, permissionId: string, action: PermissionActionId, message?: string): Promise<void>;
  respondToQuestion(ref: SessionInput, payload: QuestionSubmission | QuestionPromptPayload): Promise<void>;
  rejectQuestion(ref: SessionInput, requestId: string): Promise<void>;
  requestInterrupt(ref: SessionInput): Promise<'armed' | 'interrupted'>;
  cycleThinkingLevel(): void;
  setThinkingLevel(level: ThinkingLevel): void;
  setSessionAgent(ref: SessionInput, name: string): boolean;
  setSessionModel(ref: SessionInput, model: ModelRef): boolean;
  setSessionVariant(ref: SessionInput, variant?: string): boolean;
  cycleSessionVariant(ref?: SessionInput): void;
  togglePromptMode(): void;
  setPromptMode(mode: PromptMode): void;
  previousPromptFromHistory(): string | null;
  nextPromptFromHistory(): string | null;
  stashPrompt(text: string): void;
  popStashedPrompt(): string | null;
  recordPromptHistory(text: string): void;
  cycleAgent(): void;
  setActiveAgent(name: string): void;
  copySessionTranscript(ref: SessionInput): string;
}

const interruptWindowMs = 5_000;
const maxPromptHistory = 50;
let addConnectionQueue = Promise.resolve();
let openGeneration = 0;
let refreshGeneration = 0;
const openSessionFlights = new Map<string, Promise<void>>();
const olderMessageFlights = new Map<string, Promise<void>>();
const latestOpenGeneration = new Map<string, number>();
const latestRefreshGeneration = new Map<string, number>();
const hostRefreshFlights = new Map<string, Promise<void>>();
const permissionReads = new Map<string, number>();
const statusScopeChecks = new Map<string, Map<string, { attemptedAt: number; failed: boolean }>>();
const sessionStatusRequestTimeoutMs = 3_000;
const sessionStatusSyncBudgetMs = 10_000;

type CachePersistenceSnapshot =
  | {
      kind: 'host';
      connectionId: string;
      cache: Parameters<typeof saveHostSessionCache>[1];
    }
  | {
      kind: 'session';
      key: string;
      cache: Parameters<typeof saveSessionTranscriptCache>[1];
    };

const cachePersistence = createPersistenceCoordinator<string, CachePersistenceSnapshot>(async (_key, snapshot) => {
  if (snapshot.kind === 'host') {
    await saveHostSessionCache(snapshot.connectionId, snapshot.cache);
    return;
  }
  await saveSessionTranscriptCache(snapshot.key, snapshot.cache);
}, { debounceMs: 250 });

export function flushMobileSessionPersistence() {
  return cachePersistence.flush();
}

export const useOpenCodeMobileStore = create<MobileStore>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  activeSessionRef: null,
  activeSessionKey: null,
  activeSessionId: null,
  hydrated: false,
  projects: {},
  sessions: {},
  relayTargets: {},
  sessionStatuses: {},
  messages: {},
  messageNextCursors: {},
  olderMessageLoadStates: {},
  olderMessageErrors: {},
  sessionContexts: {},
  todos: {},
  lspStatuses: {},
  mcpStatuses: {},
  agents: {},
  commands: {},
  machineContracts: {},
  contractLoadStates: {},
  sessionSelections: {},
  sessionLoadStates: {},
  sessionErrors: {},
  activeAgentName: null,
  activeAgentByHost: {},
  activeVariant: undefined,
  questions: {},
  permissions: {},
  permissionErrors: {},
  hostSyncNotes: {},
  diffs: {},
  loading: 'idle',
  error: null,
  notice: null,
  commandPaletteOpen: false,
  hostSyncStates: {},
  hostSyncErrors: {},
  interruptArmedAt: {},
  thinkingLevel: 'high',
  promptMode: 'ask',
  promptHistory: [],
  promptHistoryCursor: null,
  stashedPrompts: [],
  queuedPrompts: [],
  eventUnsubscribers: {},
  eventSubscriptionDirectories: {},
  eventConnected: {},
  eventConnectionStates: {},
  questionRevision: 0,

  async hydrate() {
    if (get().hydrated) return;
    const [connections, savedActiveConnectionId, cache, preferences] = await Promise.all([
      loadConnections(),
      loadActiveConnectionId(),
      loadSessionCache(),
      loadPromptPreferences(),
    ]);
    const activeConnectionId = connections.some((connection) => connection.id === savedActiveConnectionId)
      ? savedActiveConnectionId
      : null;
    const migrated = migrateSessionCache(cache);
    set({
      connections,
      activeConnectionId,
      sessions: migrated.sessions,
      projects: migrated.projects,
      sessionStatuses: migrated.sessionStatuses,
      messages: migrated.messages,
      diffs: migrated.diffs,
      todos: migrated.todos,
      sessionContexts: migrated.sessionContexts,
      lspStatuses: migrated.lspStatuses,
      mcpStatuses: migrated.mcpStatuses,
      activeAgentByHost: preferences.activeAgentByHost,
      thinkingLevel: preferences.thinkingLevel,
      promptMode: preferences.promptMode,
      queuedPrompts: [],
      hydrated: true,
    });
    if (cache.queuedPrompts.length > 0) void saveQueuedPromptsCache([]).catch(() => undefined);
  },

  async addConnection(input) {
    addConnectionQueue = addConnectionQueue.catch(() => undefined).then(async () => {
      const normalizedUrl = normalizeConnectionUrl(input.url);
      const existing = get().connections.find(
        (connection) => connection.authType === input.authType && normalizeConnectionUrl(connection.url) === normalizedUrl,
      );
      if (existing) {
        const connections = get().connections.map((connection) =>
          connection.id === existing.id
            ? { ...connection, ...input, url: normalizedUrl, lastConnected: connection.lastConnected, isReachable: connection.isReachable }
            : connection,
        );
        await saveConnections(connections);
        set({ connections });
        return;
      }
      const connection: HostConnection = {
        ...input,
        id: cryptoRandomId(),
        url: normalizedUrl,
        lastConnected: null,
        isReachable: false,
      };
      const connections = [...get().connections, connection];
      await saveConnections(connections);
      set({ connections });
    });
    return addConnectionQueue;
  },

  async pairConnection(input) {
    let pairedConnectionId = '';
    addConnectionQueue = addConnectionQueue.catch(() => undefined).then(async () => {
      const normalizedUrl = normalizeConnectionUrl(input.url);
      const token = input.token.trim();
      if (!token) throw new Error('Paired relay did not provide a bearer token');
      const existing = get().connections.find(
        (connection) => connection.authType === 'bearer' && normalizeConnectionUrl(connection.url) === normalizedUrl,
      );
      pairedConnectionId = existing?.id ?? cryptoRandomId();
      const paired: HostConnection = {
        id: pairedConnectionId,
        name: input.name.trim() || new URL(normalizedUrl).host,
        url: normalizedUrl,
        authType: 'bearer',
        token,
        relayDeviceID: input.clientID,
        relayNameRevision: input.displayNameRevision,
        lastConnected: existing?.lastConnected ?? null,
        isReachable: existing?.isReachable ?? false,
      };
      if (existing) await removeConnectionSecrets(existing.id);
      const connections = existing
        ? get().connections.map((connection) => (connection.id === existing.id ? paired : connection))
        : [...get().connections, paired];
      await saveConnections(connections);
      await saveActiveConnectionId(pairedConnectionId);
      set({
        connections,
        activeConnectionId: pairedConnectionId,
        activeSessionRef: null,
        activeSessionKey: null,
        activeSessionId: null,
        activeAgentName: null,
        activeVariant: undefined,
      });
    });
    await addConnectionQueue;
    if (!pairedConnectionId) throw new Error('Unable to save paired relay');
    return pairedConnectionId;
  },

  async updateConnection(id, input) {
    addConnectionQueue = addConnectionQueue.catch(() => undefined).then(async () => {
      const current = get().connections.find((connection) => connection.id === id);
      if (!current) throw new Error('Host connection no longer exists');
      let updated: HostConnection = {
        ...current,
        ...input,
        id,
        url: normalizeConnectionUrl(input.url),
        lastConnected: current.lastConnected,
        isReachable: current.isReachable,
      };
      if (
        current.relayDeviceID
        && current.name !== updated.name
        && current.authType === 'bearer'
        && updated.authType === 'bearer'
        && current.token === updated.token
        && normalizeConnectionUrl(current.url) === updated.url
      ) {
        const identity = await new OpenCodeClient(updated).renameRelayDevice(updated.name);
        if (identity.clientID !== current.relayDeviceID) throw new Error('Relay returned a different phone identity');
        updated = applyRelayDeviceIdentity(updated, identity);
      }
      const connections = get().connections.map((connection) => (connection.id === id ? updated : connection));
      await removeConnectionSecrets(id);
      await saveConnections(connections);
      set({ connections });
    });
    return addConnectionQueue;
  },

  async removeConnection(id) {
    addConnectionQueue = addConnectionQueue.catch(() => undefined).then(async () => {
      const current = get();
      if (!current.connections.some((connection) => connection.id === id)) return;
      const connections = current.connections.filter((connection) => connection.id !== id);
      const wasActive = current.activeConnectionId === id;
      current.unsubscribeFromHost(id);
      if (wasActive) await saveActiveConnectionId(null);
      await saveConnections(connections);
      await removeConnectionSecrets(id);
      set((state) => ({
        connections,
        sessions: omitRecordKey(state.sessions, id),
        projects: omitRecordKey(state.projects, id),
        relayTargets: omitRecordKey(state.relayTargets, id),
        sessionStatuses: omitCompositeConnection(state.sessionStatuses, id),
        messages: omitCompositeConnection(state.messages, id),
        messageNextCursors: omitCompositeConnection(state.messageNextCursors, id),
        olderMessageLoadStates: omitCompositeConnection(state.olderMessageLoadStates, id),
        olderMessageErrors: omitCompositeConnection(state.olderMessageErrors, id),
        diffs: omitCompositeConnection(state.diffs, id),
        todos: omitCompositeConnection(state.todos, id),
        sessionContexts: omitCompositeConnection(state.sessionContexts, id),
        lspStatuses: omitCompositeConnection(state.lspStatuses, id),
        mcpStatuses: omitCompositeConnection(state.mcpStatuses, id),
        questions: omitCompositeConnection(state.questions, id),
        permissions: omitCompositeConnection(state.permissions, id),
        permissionErrors: omitCompositeConnection(state.permissionErrors, id),
        sessionSelections: omitCompositeConnection(state.sessionSelections, id),
        sessionLoadStates: omitCompositeConnection(state.sessionLoadStates, id),
        sessionErrors: omitCompositeConnection(state.sessionErrors, id),
        machineContracts: omitScopeConnection(state.machineContracts, id),
        contractLoadStates: omitScopeConnection(state.contractLoadStates, id),
        agents: omitScopeConnection(state.agents, id),
        commands: omitScopeConnection(state.commands, id),
        hostSyncStates: omitRecordKey(state.hostSyncStates, id),
        hostSyncErrors: omitRecordKey(state.hostSyncErrors, id),
        hostSyncNotes: omitRecordKey(state.hostSyncNotes, id),
        ...(wasActive
          ? {
              activeConnectionId: null,
              activeSessionRef: null,
              activeSessionKey: null,
              activeSessionId: null,
              activeAgentName: null,
              activeVariant: undefined,
            }
          : {}),
      }));
    });
    return addConnectionQueue;
  },

  setActiveConnection(id) {
    if (!get().connections.some((connection) => connection.id === id)) return false;
    const previous = get().activeConnectionId;
    if (previous && previous !== id) get().unsubscribeFromHost(previous);
    void saveActiveConnectionId(id);
    set({
      activeConnectionId: id,
      activeSessionRef: null,
      activeSessionKey: null,
      activeSessionId: null,
      activeAgentName: null,
      activeVariant: undefined,
      error: null,
    });
    return true;
  },

  showNotice(message) {
    set({ notice: message });
  },

  dismissNotice() {
    set({ notice: null });
  },

  openCommandPalette() {
    set({ commandPaletteOpen: true });
  },

  closeCommandPalette() {
    set({ commandPaletteOpen: false });
  },

  clearActiveConnection() {
    const activeId = get().activeConnectionId;
    if (activeId) get().unsubscribeFromHost(activeId);
    void saveActiveConnectionId(null);
    set({
      activeConnectionId: null,
      activeSessionRef: null,
      activeSessionKey: null,
      activeSessionId: null,
      activeAgentName: null,
      activeVariant: undefined,
      error: null,
    });
  },

  async refreshActiveHost(options = {}) {
    const connection = activeConnection(get());
    if (!connection) return;
    const existing = hostRefreshFlights.get(connection.id);
    if (existing) return existing;
    const flight = refreshHost(connection, options, get, set).finally(() => {
      if (hostRefreshFlights.get(connection.id) === flight) hostRefreshFlights.delete(connection.id);
    });
    hostRefreshFlights.set(connection.id, flight);
    return flight;
  },

  subscribeToActiveHost() {
    const state = get();
    const ref = state.activeSessionRef;
    if (!ref || state.activeConnectionId !== ref.connectionId) return;
    const connection = connectionForRef(state, ref);
    const session = currentSessionForRef(state, ref);
    if (!connection || !session) return;
    const key = sessionStateKey(ref);
    const directory = directoryForSession(session);
    const existing = state.eventUnsubscribers[key];
    if (existing && state.eventSubscriptionDirectories[key] === directory) return;

    const replacedKeys = Object.keys(state.eventUnsubscribers).filter((otherKey) => otherKey !== key);
    for (const [otherKey, unsubscribe] of Object.entries(state.eventUnsubscribers)) {
      if (otherKey !== key) unsubscribe?.();
    }
    existing?.();
    const unsubscribe = clientFor(connection, ref.relayTargetID).subscribeEvents(
      (event) => {
        const eventSessionId = sessionIdFromServerEvent(event);
        const eventRef = eventSessionId ? { ...ref, sessionId: eventSessionId } : ref;
        set((current) => applyServerEvent(current, eventRef, event));
        persistHostCache(ref.connectionId, get());
        if (eventSessionId) persistTranscriptCache(eventRef, get());
      },
      {
        directory,
        onConnectionState: (connectionState) => {
          if (!get().eventUnsubscribers[key]) return;
          set((current) => ({
            eventConnected: { ...current.eventConnected, [key]: connectionState === 'live' },
            eventConnectionStates: { ...current.eventConnectionStates, [key]: connectionState },
          }));
          // Reconcile after the stream opens as well: a gate may have been
          // asked between the initial REST snapshot and SSE connection.
          if (connectionState === 'live') void refreshSessionPermissions(ref, connection, get, set);
        },
        onReconnect: async () => {
          if (get().activeSessionKey !== key) return;
          await Promise.all([
            get().refreshActiveHost({ background: true }),
            openSessionInBackground(ref, connection, get, set),
          ]);
        },
      },
    );
    set((current) => ({
      eventUnsubscribers: { [key]: unsubscribe },
      eventSubscriptionDirectories: { [key]: directory },
      eventConnected: {
        ...current.eventConnected,
        ...Object.fromEntries(replacedKeys.map((replacedKey) => [replacedKey, false])),
      },
      eventConnectionStates: {
        ...current.eventConnectionStates,
        ...Object.fromEntries(replacedKeys.map((replacedKey) => [replacedKey, 'idle' as const])),
        [key]: 'connecting',
      },
    }));
  },

  unsubscribeFromHost(connectionId) {
    const current = get();
    const removedKeys = Object.keys(current.eventUnsubscribers).filter(
      (key) => decodeSessionStateKey(key)?.connectionId === connectionId,
    );
    for (const key of removedKeys) current.eventUnsubscribers[key]?.();
    set((state) => ({
      eventUnsubscribers: omitKeys(state.eventUnsubscribers, removedKeys),
      eventSubscriptionDirectories: omitKeys(state.eventSubscriptionDirectories, removedKeys),
      eventConnected: { ...state.eventConnected, ...Object.fromEntries(removedKeys.map((key) => [key, false])) },
      eventConnectionStates: { ...state.eventConnectionStates, ...Object.fromEntries(removedKeys.map((key) => [key, 'idle' as const])) },
    }));
    void flushMobileSessionPersistence().catch(() => undefined);
  },

  async openSession(input) {
    let ref: SessionRef;
    try {
      ref = resolveSessionInput(input, get());
    } catch (error) {
      set({ loading: 'error', error: errorMessage(error) });
      return;
    }
    const key = sessionStateKey(ref);
    const session = currentSessionForRef(get(), ref);
    if (!session) {
      set({ loading: 'error', error: `Session ${ref.sessionId} is not present on relay target ${ref.relayTargetID}` });
      return;
    }
    const scopeKey = executionScopeKey(ref, directoryForSession(session));
    const contractAttemptedAt = new Date().toISOString();
    const previousConnectionId = get().activeConnectionId;
    if (previousConnectionId !== ref.connectionId) {
      if (previousConnectionId) get().unsubscribeFromHost(previousConnectionId);
      void saveActiveConnectionId(ref.connectionId);
    }
    set((state) => ({
      activeConnectionId: ref.connectionId,
      activeSessionRef: ref,
      activeSessionKey: key,
      activeSessionId: ref.sessionId,
      loading: 'loading',
      error: null,
      sessionLoadStates: { ...state.sessionLoadStates, [key]: 'loading' },
      sessionErrors: { ...state.sessionErrors, [key]: null },
      contractLoadStates: {
        ...state.contractLoadStates,
        [scopeKey]: {
          status: 'loading',
          attemptedAt: contractAttemptedAt,
          verifiedAt: state.contractLoadStates[scopeKey]?.verifiedAt ?? state.machineContracts[scopeKey]?.fetchedAt,
          error: null,
        },
      },
    }));

    const existing = openSessionFlights.get(key);
    if (existing) return existing;
    const connection = connectionForRef(get(), ref);
    if (!connection) return;
    const generation = ++openGeneration;
    latestOpenGeneration.set(key, generation);
    const flight = loadSession(ref, connection, generation, get, set).finally(() => {
      if (openSessionFlights.get(key) === flight) openSessionFlights.delete(key);
    });
    openSessionFlights.set(key, flight);
    return flight;
  },

  async loadOlderMessages(input) {
    let ref: SessionRef;
    try {
      ref = resolveSessionInput(input, get());
    } catch (error) {
      set({ error: errorMessage(error) });
      return;
    }
    const key = sessionStateKey(ref);
    const cursor = get().messageNextCursors[key];
    if (!cursor) return;
    const existing = olderMessageFlights.get(key);
    if (existing) return existing;
    const connection = connectionForRef(get(), ref);
    if (!connection) return;

    set((state) => ({
      olderMessageLoadStates: { ...state.olderMessageLoadStates, [key]: 'loading' },
      olderMessageErrors: { ...state.olderMessageErrors, [key]: null },
    }));
    const flight = (async () => {
      try {
        const page = await clientFor(connection, ref.relayTargetID).listMessagePage(ref.sessionId, {
          limit: DEFAULT_MESSAGE_PAGE_LIMIT,
          before: cursor,
        });
        if (page.nextCursor === cursor) {
          throw new Error('OpenCode message pagination returned a repeated cursor');
        }
        set((state) => {
          if (state.messageNextCursors[key] !== cursor) return {};
          return {
            messages: {
              ...state.messages,
              [key]: mergeRestWithLiveMessages(page.items, state.messages[key] ?? []),
            },
            messageNextCursors: { ...state.messageNextCursors, [key]: page.nextCursor },
            olderMessageLoadStates: { ...state.olderMessageLoadStates, [key]: 'idle' },
            olderMessageErrors: { ...state.olderMessageErrors, [key]: null },
          };
        });
        persistTranscriptCache(ref, get());
      } catch (error) {
        const message = errorMessage(error);
        set((state) => ({
          olderMessageLoadStates: { ...state.olderMessageLoadStates, [key]: 'error' },
          olderMessageErrors: { ...state.olderMessageErrors, [key]: message },
        }));
      }
    })().finally(() => {
      if (olderMessageFlights.get(key) === flight) olderMessageFlights.delete(key);
    });
    olderMessageFlights.set(key, flight);
    return flight;
  },

  async searchFileReferences(query, input) {
    const trimmed = query.trim();
    if (!trimmed) return [];
    let ref: SessionRef | undefined;
    try {
      ref = input ? resolveSessionInput(input, get()) : get().activeSessionRef ?? undefined;
    } catch {
      return [];
    }
    if (!ref) return [];
    const connection = connectionForRef(get(), ref);
    const session = currentSessionForRef(get(), ref);
    if (!connection || !session) return [];
    const client = clientFor(connection, ref.relayTargetID);
    const options = { ...workspaceQueryForSession(session), limit: 20, type: 'file' as const };
    try {
      return await client.findFiles(trimmed, options);
    } catch {
      try {
        return await client.findFiles(trimmed, { limit: 20, type: 'file' });
      } catch {
        return [];
      }
    }
  },

  startNewSessionPrompt() {
    // Creation itself lives in createSession; this only clears a stale banner so
    // the screen that offers the choices opens on a clean slate.
    set({ error: null });
  },

  async loadMachineContract({ connectionId, relayTargetID, directory }) {
    const connection = get().connections.find((item) => item.id === connectionId);
    if (!connection) return false;
    const client = clientFor(connection, relayTargetID);
    const query = directory ? { directory } : {};
    const [agentsResult, providersResult, configResult, commandsResult] = await Promise.allSettled([
      client.listAgents(query),
      client.listConfiguredProviders ? client.listConfiguredProviders(query) : Promise.resolve(undefined),
      client.getConfig ? client.getConfig(query) : Promise.resolve(undefined),
      client.listCommands(query),
    ]);
    if (agentsResult.status !== 'fulfilled' || providersResult.status !== 'fulfilled') return false;

    const ref: SessionRef = { connectionId, relayTargetID: relayTargetID ?? '', sessionId: '' };
    const contract = buildMachineContract({
      ref,
      session: { id: '', directory } as Session,
      agents: agentsResult.value,
      providers: providersResult.value,
      config: fulfilledOr(configResult, undefined),
      commands: fulfilledOr(commandsResult, []),
    });
    if (!contract) return false;

    const scopeKey = executionScopeKey(ref, directory);
    set((state) => ({ machineContracts: { ...state.machineContracts, [scopeKey]: contract } }));
    return true;
  },

  async createSession({ connectionId, relayTargetID, directory, title }) {
    const connection = get().connections.find((item) => item.id === connectionId);
    if (!connection) {
      set({ error: 'Select a host before creating a session.' });
      return null;
    }
    try {
      const session = await clientFor(connection, relayTargetID).createSession(title, directory);
      const ref = sessionRefFor(connectionId, { ...session, relayTargetID });
      set((state) => applySessionUpdate(state, ref, session));
      return ref;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  async sendPrompt(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const ref = get().activeSessionRef;
    if (!ref) {
      set({ error: 'Select an existing session before sending a message.' });
      return null;
    }
    const key = sessionStateKey(ref);
    const connection = connectionForRef(get(), ref);
    const session = currentSessionForRef(get(), ref);
    const selection = get().sessionSelections[key];
    if (!connection || !session) {
      const message = 'The selected session routing target is no longer available.';
      set((state) => ({ error: message, sessionErrors: { ...state.sessionErrors, [key]: message } }));
      return null;
    }
    const scopeKey = executionScopeKey(ref, directoryForSession(session));
    const contractState = get().contractLoadStates[scopeKey];
    const contract = get().machineContracts[scopeKey];
    if (!contract || contractState?.status !== 'fresh') {
      const message = contractDispatchBlockedMessage(contractState);
      set((state) => ({ error: message, sessionErrors: { ...state.sessionErrors, [key]: message } }));
      return null;
    }
    if (!selection?.agentName || !selection.model) {
      const message = 'This machine has not supplied a valid agent and model contract for the selected session.';
      set((state) => ({ error: message, sessionErrors: { ...state.sessionErrors, [key]: message } }));
      return null;
    }
    const dispatch: PromptDispatchOptions = {
      agent: selection.agentName,
      model: selection.model,
      variant: selection.variant,
      directory: directoryForSession(session),
    };
    try {
      await dispatchPrompt(clientFor(connection, ref.relayTargetID), ref.sessionId, trimmed, get().promptMode, dispatch);
    } catch (error) {
      const message = errorMessage(error);
      set((state) => ({ error: message, sessionErrors: { ...state.sessionErrors, [key]: message } }));
      get().recordPromptHistory(trimmed);
      return null;
    }
    get().recordPromptHistory(trimmed);
    await openSessionInBackground(ref, connection, get, set);
    return ref.sessionId;
  },

  async flushQueuedPrompts(connectionId) {
    const queuedPrompts = connectionId
      ? get().queuedPrompts.filter((prompt) => prompt.connectionId !== connectionId)
      : [];
    set({ queuedPrompts });
    await saveQueuedPromptsCache(queuedPrompts).catch(() => undefined);
  },

  async renameSession(input, title) {
    const trimmed = title.trim();
    if (!trimmed) return;
    const { ref, connection, session } = requireSessionContext(input, get());
    const updated = await clientFor(connection, ref.relayTargetID).updateSession(ref.sessionId, { title: trimmed });
    set((state) => applySessionUpdate(state, ref, { ...updated, relayTargetID: ref.relayTargetID, relayTargetName: session.relayTargetName }));
  },

  async shareSession(input) {
    const { ref, connection, session } = requireSessionContext(input, get());
    const updated = await clientFor(connection, ref.relayTargetID).shareSession(ref.sessionId);
    const routed = { ...updated, relayTargetID: ref.relayTargetID, relayTargetName: session.relayTargetName };
    set((state) => applySessionUpdate(state, ref, routed));
    return routed.share?.url ?? routed.shareUrl ?? routed.shareURL ?? null;
  },

  async forkSession(input, _messageId) {
    // Fork is a creation operation even though it starts from an existing
    // transcript. Monitor/control-only mobile clients must never invoke it.
    try {
      resolveSessionInput(input, get());
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
    const { ref, connection } = requireSessionContext(input, get());
    try {
      const forked = await clientFor(connection, ref.relayTargetID).forkSession(ref.sessionId, _messageId);
      const forkedRef = sessionRefFor(ref.connectionId, { ...forked, relayTargetID: ref.relayTargetID });
      set((state) => applySessionUpdate(state, forkedRef, forked));
      return forkedRef.sessionId;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  async deleteSession(input) {
    const { ref, session } = requireSessionContext(input, get());
    const connection = get().connections.find((item) => item.id === ref.connectionId);
    if (!connection) throw new Error('That session belongs to a host this device no longer has.');
    await clientFor(connection, ref.relayTargetID).deleteSession(ref.sessionId, { directory: session.directory });
    const key = sessionStateKey(ref);
    set((state) => ({
      sessions: {
        ...state.sessions,
        [ref.connectionId]: (state.sessions[ref.connectionId] ?? []).filter((item) => item.id !== ref.sessionId),
      },
      sessionStatuses: omitRecordKey(state.sessionStatuses, key),
      ...(state.activeSessionKey === key
        ? { activeSessionRef: null, activeSessionKey: null, activeSessionId: null }
        : {}),
    }));
    set((state) => ({ projects: { ...state.projects, [ref.connectionId]: groupSessionsByDirectory(state.sessions[ref.connectionId] ?? []) } }));
  },

  async compactSession(input) {
    const { ref, connection } = requireSessionContext(input, get());
    const selection = get().sessionSelections[sessionStateKey(ref)];
    if (!selection?.model) {
      set({ error: 'Compact requires a model from the selected machine contract.' });
      return;
    }
    await clientFor(connection, ref.relayTargetID).compactSession(ref.sessionId, selection.model);
    await get().openSession(ref);
  },

  async revertMessage(input, messageId) {
    const { ref, connection, session } = requireSessionContext(input, get());
    const updated = await clientFor(connection, ref.relayTargetID).revertMessage(ref.sessionId, messageId);
    set((state) => applySessionUpdate(state, ref, { ...updated, relayTargetID: ref.relayTargetID, relayTargetName: session.relayTargetName }));
    await get().openSession(ref);
  },

  async unrevertSession(input) {
    const { ref, connection, session } = requireSessionContext(input, get());
    const updated = await clientFor(connection, ref.relayTargetID).unrevertSession(ref.sessionId);
    set((state) => applySessionUpdate(state, ref, { ...updated, relayTargetID: ref.relayTargetID, relayTargetName: session.relayTargetName }));
    await get().openSession(ref);
  },

  async respondToPermission(input, permissionId, action, message) {
    const { ref, connection, session } = requireSessionContext(input, get());
    await clientFor(connection, ref.relayTargetID).respondToPermission(
      ref.sessionId,
      permissionId,
      createPermissionReply(action, message),
      workspaceQueryForSession(session),
    );
    const key = sessionStateKey(ref);
    set((state) => ({
      permissions: { ...state.permissions, [key]: (state.permissions[key] ?? []).filter((request) => request.id !== permissionId) },
      permissionErrors: { ...state.permissionErrors, [key]: null },
    }));
  },

  async respondToQuestion(input, payload) {
    const { ref, connection, session } = requireSessionContext(input, get());
    const requestID = 'requestID' in payload ? payload.requestID : payload.questionID;
    const body = 'requestID' in payload ? { answers: payload.answers } : createQuestionReplyBody(payload);
    await clientFor(connection, ref.relayTargetID).respondToQuestion(requestID, body, workspaceQueryForSession(session));
    const key = sessionStateKey(ref);
    set((state) => ({
      questions: { ...state.questions, [key]: (state.questions[key] ?? []).filter((request) => request.id !== requestID) },
      questionRevision: state.questionRevision + 1,
    }));
  },

  async rejectQuestion(input, requestId) {
    const { ref, connection, session } = requireSessionContext(input, get());
    await clientFor(connection, ref.relayTargetID).rejectQuestion(requestId, workspaceQueryForSession(session));
    const key = sessionStateKey(ref);
    set((state) => ({
      questions: { ...state.questions, [key]: (state.questions[key] ?? []).filter((request) => request.id !== requestId) },
      questionRevision: state.questionRevision + 1,
    }));
  },

  async requestInterrupt(input) {
    const { ref, connection } = requireSessionContext(input, get());
    const key = sessionStateKey(ref);
    const armedAt = get().interruptArmedAt[key] ?? 0;
    const now = Date.now();
    if (!armedAt || now - armedAt > interruptWindowMs) {
      set((state) => ({ interruptArmedAt: { ...state.interruptArmedAt, [key]: now } }));
      return 'armed';
    }
    await clientFor(connection, ref.relayTargetID).abortSession(ref.sessionId);
    set((state) => ({ interruptArmedAt: omitRecordKey(state.interruptArmedAt, key) }));
    return 'interrupted';
  },

  cycleThinkingLevel() {
    get().cycleSessionVariant();
  },

  setThinkingLevel(level) {
    const ref = get().activeSessionRef;
    if (ref && get().setSessionVariant(ref, level)) {
      set({ thinkingLevel: level });
      persistPromptPreferences(get());
    }
  },

  setSessionAgent(input, name) {
    let context: ReturnType<typeof selectionContext>;
    try {
      context = selectionContext(input, get());
    } catch {
      return false;
    }
    const next = resolvePromptSelection({
      contract: contractForResolver(context.contract),
      messages: get().messages[context.key] ?? [],
      session: context.session,
      override: { agentName: name },
    });
    if (!next || next.agentName !== name) return false;
    applySelection(set, get, context.ref, next);
    return true;
  },

  setSessionModel(input, model) {
    let context: ReturnType<typeof selectionContext>;
    try {
      context = selectionContext(input, get());
    } catch {
      return false;
    }
    const catalog = flattenConfiguredModels({
      providers: context.contract.providers,
      default: context.contract.providerDefaults,
    });
    if (!catalog.some((entry) => entry.ref.providerID === model.providerID && entry.ref.modelID === model.modelID)) return false;
    const current = get().sessionSelections[context.key];
    if (!current?.agentName) return false;
    applySelection(set, get, context.ref, { agentName: current.agentName, model });
    return true;
  },

  setSessionVariant(input, variant) {
    let context: ReturnType<typeof selectionContext>;
    try {
      context = selectionContext(input, get());
    } catch {
      return false;
    }
    const current = get().sessionSelections[context.key];
    if (!current?.agentName || !current.model) return false;
    const variants = variantsForModel(
      { providers: context.contract.providers, default: context.contract.providerDefaults },
      current.model,
    );
    if (variant !== undefined && !variants.includes(variant)) return false;
    applySelection(
      set,
      get,
      context.ref,
      variant === undefined
        ? { agentName: current.agentName, model: current.model }
        : { ...current, variant },
      true,
    );
    return true;
  },

  cycleSessionVariant(input) {
    let context: ReturnType<typeof selectionContext>;
    try {
      context = selectionContext(input ?? get().activeSessionRef ?? '', get());
    } catch {
      return;
    }
    const current = get().sessionSelections[context.key];
    if (!current?.model) return;
    const variants = variantsForModel(
      { providers: context.contract.providers, default: context.contract.providerDefaults },
      current.model,
    );
    if (variants.length === 0) return;
    const index = variants.findIndex((variant) => variant === current.variant);
    get().setSessionVariant(context.ref, variants[(index + 1) % variants.length]);
  },

  togglePromptMode() {
    set((state) => ({ promptMode: state.promptMode === 'ask' ? 'shell' : 'ask' }));
    persistPromptPreferences(get());
  },

  setPromptMode(mode) {
    set({ promptMode: mode });
    persistPromptPreferences(get());
  },

  previousPromptFromHistory() {
    const history = get().promptHistory;
    if (history.length === 0) return null;
    const current = get().promptHistoryCursor;
    const nextCursor = current === null ? history.length - 1 : Math.max(0, current - 1);
    set({ promptHistoryCursor: nextCursor });
    return history[nextCursor];
  },

  nextPromptFromHistory() {
    const history = get().promptHistory;
    if (history.length === 0) return null;
    const current = get().promptHistoryCursor;
    if (current === null) return null;
    const nextCursor = current + 1;
    if (nextCursor >= history.length) {
      set({ promptHistoryCursor: null });
      return '';
    }
    set({ promptHistoryCursor: nextCursor });
    return history[nextCursor];
  },

  stashPrompt(text) {
    const trimmed = text.trim();
    if (trimmed) set((state) => ({ stashedPrompts: [...state.stashedPrompts, trimmed] }));
  },

  popStashedPrompt() {
    const stash = get().stashedPrompts;
    const prompt = stash.at(-1) ?? null;
    if (prompt) set({ stashedPrompts: stash.slice(0, -1) });
    return prompt;
  },

  recordPromptHistory(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    set((state) => ({
      promptHistory: [...state.promptHistory.filter((item) => item !== trimmed), trimmed].slice(-maxPromptHistory),
      promptHistoryCursor: null,
    }));
  },

  cycleAgent() {
    const ref = get().activeSessionRef;
    if (!ref) return;
    let context: ReturnType<typeof selectionContext>;
    try {
      context = selectionContext(ref, get());
    } catch {
      return;
    }
    const visible = context.contract.agents.filter((agent) => !agent.hidden && agent.mode !== 'subagent');
    if (visible.length === 0) return;
    const current = get().sessionSelections[context.key]?.agentName;
    const index = visible.findIndex((agent) => agent.name === current);
    get().setSessionAgent(ref, visible[(index + 1) % visible.length].name);
  },

  setActiveAgent(name) {
    const ref = get().activeSessionRef;
    if (ref) get().setSessionAgent(ref, name);
  },

  copySessionTranscript(input) {
    let ref: SessionRef;
    try {
      ref = resolveSessionInput(input, get());
    } catch {
      return '';
    }
    return sortMessagesChronologically(get().messages[sessionStateKey(ref)] ?? [])
      .map((message) => {
        const parts = message.parts.map(partToText).filter(Boolean).join('\n');
        return `[${message.info.role}]\n${parts}`;
      })
      .join('\n\n');
  },
}));

type StoreGet = () => MobileStore;
type StoreSet = (
  partial: Partial<MobileStore> | ((state: MobileStore) => Partial<MobileStore>),
) => void;

async function refreshHost(
  connection: HostConnection,
  options: { background?: boolean },
  get: StoreGet,
  set: StoreSet,
) {
  const generation = ++refreshGeneration;
  latestRefreshGeneration.set(connection.id, generation);
  set((state) => ({
    hostSyncStates: { ...state.hostSyncStates, [connection.id]: 'loading' },
    hostSyncErrors: { ...state.hostSyncErrors, [connection.id]: null },
    hostSyncNotes: { ...state.hostSyncNotes, [connection.id]: null },
    ...(!options.background ? { loading: 'loading' as const, error: null } : {}),
  }));

  try {
    const baseClient = clientFor(connection);
    const [identityResult, targetResult] = await Promise.allSettled([
      connection.authType === 'bearer' ? baseClient.getRelayDeviceIdentity() : Promise.resolve(undefined),
      baseClient.listRelayTargets(),
    ]);
    const targets = targetResult.status === 'fulfilled'
      ? normalizeTargets(targetResult.value)
      : targetListFailureFallback(targetResult.reason, connection);
    const probes = await Promise.all(targets.map((target) => probeRelayTarget(connection, target)));
    const successful = probes.filter((probe) => probe.sessions.status === 'fulfilled');
    if (successful.length === 0) {
      throw probes.flatMap((probe) => probe.errors)[0] ?? new Error('No authorized relay machine is reachable');
    }
    if (latestRefreshGeneration.get(connection.id) !== generation) return;

    let connections = get().connections;
    if (identityResult.status === 'fulfilled' && identityResult.value) {
      const identity = identityResult.value;
      if (!connection.relayDeviceID || connection.relayDeviceID === identity.clientID) {
        connections = connections.map((item) => item.id === connection.id ? applyRelayDeviceIdentity(item, identity) : item);
      }
    }

    const successfulTargetIDs = new Set(successful.map((probe) => probe.target.id));
    const targetNames = new Map(targets.map((target) => [target.id, target.name]));
    const retained = (get().sessions[connection.id] ?? []).filter((session) =>
      !successfulTargetIDs.has(session.relayTargetID ?? DIRECT_RELAY_TARGET_ID),
    ).map((session) => {
      const canonicalName = session.relayTargetID ? targetNames.get(session.relayTargetID) : undefined;
      return canonicalName ? { ...session, relayTargetName: canonicalName } : session;
    });
    const sessions = [
      ...successful.flatMap((probe) => (probe.sessions as PromiseFulfilledResult<Session[]>).value),
      ...retained,
    ].sort(compareSessionsByRecency);
    const relayTargets = probes.map((probe): RelayTargetState => ({
      ...probe.target,
      reachable: probe.sessions.status === 'fulfilled',
      lastChecked: new Date().toISOString(),
      ...(probe.errors[0] ? { error: errorMessage(probe.errors[0]) } : {}),
    }));
    const health = aggregateHealth(probes);
    connections = markReachable(connections, connection.id, health);
    const projects = groupSessionsByDirectory(sessions);
    const syncError = summarizeSyncIssues(
      probes.flatMap((probe) => probe.errors.map((error) => `${probe.target.name}: ${errorMessage(error)}`)),
    );
    await saveConnections(connections);
    if (latestRefreshGeneration.get(connection.id) !== generation) return;
    set((state) => ({
      connections,
      sessions: { ...state.sessions, [connection.id]: sessions },
      projects: { ...state.projects, [connection.id]: projects },
      relayTargets: { ...state.relayTargets, [connection.id]: relayTargets },
      hostSyncErrors: { ...state.hostSyncErrors, [connection.id]: syncError },
      ...(state.activeConnectionId === connection.id
        ? { loading: syncError ? 'error' as const : 'idle' as const, error: syncError }
        : {}),
    }));

    // Publish the fast machine-wide index before touching directory instances.
    // Historical directories can block in config/plugin initialization.
    const stillCurrent = () => latestRefreshGeneration.get(connection.id) === generation
      && get().connections.some((item) => item.id === connection.id);
    const statusResults = await Promise.all(successful.map(async (probe) => {
      const result = await refreshTargetStatuses(connection, probe.target,
        (probe.sessions as PromiseFulfilledResult<Session[]>).value, get, (snapshot) => {
          if (!stillCurrent()) return;
          set((state) => ({ sessionStatuses: mergeSessionStatusSnapshots(state.sessionStatuses, [snapshot]) }));
        }, stillCurrent);
      return { ...result, name: probe.target.name };
    }));
    if (!stillCurrent()) return;
    const finalError = summarizeSyncIssues([
      ...probes.flatMap((probe) => probe.errors.map((error) => `${probe.target.name}: ${errorMessage(error)}`)),
      ...statusResults.filter((result) => result.failed > 0).map((result) =>
        `${result.name}: running-state checks failed for ${result.failed} project ${result.failed === 1 ? 'directory' : 'directories'}`),
    ]);
    const statusNote = statusResults.flatMap((result) => result.deferred > 0
      ? [`${result.name}: ${result.deferred} project ${result.deferred === 1 ? 'directory' : 'directories'} awaiting their first running-state check`]
      : result.stale ? [`${result.name}: showing previously checked running states`] : []).join('; ') || null;
    set((state) => ({
      hostSyncStates: { ...state.hostSyncStates, [connection.id]: finalError ? 'error' : 'idle' },
      hostSyncErrors: { ...state.hostSyncErrors, [connection.id]: finalError },
      hostSyncNotes: { ...state.hostSyncNotes, [connection.id]: statusNote },
      ...(state.activeConnectionId === connection.id
        ? { loading: finalError ? 'error' as const : 'idle' as const, error: finalError }
        : {}),
    }));
    void saveHostSessionCache(connection.id, {
      sessions,
      projects,
      sessionStatuses: compositeValuesForConnection(get().sessionStatuses, connection.id),
      agents: [],
      commands: [],
    }).catch(() => undefined);
  } catch (error) {
    if (latestRefreshGeneration.get(connection.id) === generation) {
      const message = errorMessage(error);
      set((state) => ({
        hostSyncStates: { ...state.hostSyncStates, [connection.id]: 'error' },
        hostSyncErrors: { ...state.hostSyncErrors, [connection.id]: message },
        ...(state.activeConnectionId === connection.id ? { loading: 'error' as const, error: message } : {}),
      }));
    }
  }
}

interface TargetProbe {
  target: RelayTarget;
  health: PromiseSettledResult<HealthResponse>;
  sessions: PromiseSettledResult<Session[]>;
  errors: unknown[];
}

interface SessionStatusSnapshot {
  previous: Record<string, SessionStatus>;
  values: Record<string, SessionStatus>;
}

async function readSessionStatusSnapshot(
  client: OpenCodeClient,
  ref: Pick<SessionRef, 'connectionId' | 'relayTargetID'>,
  sessions: Session[],
  get: StoreGet,
  policy: RequestPolicy = {},
): Promise<SessionStatusSnapshot> {
  const previous = get().sessionStatuses;
  const statuses = await client.getSessionStatus(workspaceQueryForSession(sessions[0]), policy);
  return {
    previous,
    values: Object.fromEntries(sessions.map((session) => [
      sessionStateKey({ ...ref, sessionId: session.id }),
      // OpenCode omits idle sessions from a successful directory snapshot.
      statuses[session.id] ?? { type: 'idle' as const },
    ])),
  };
}

function mergeSessionStatusSnapshots(current: Record<string, SessionStatus>, snapshots: SessionStatusSnapshot[]) {
  const merged = { ...current };
  for (const snapshot of snapshots) {
    for (const [key, status] of Object.entries(snapshot.values)) {
      // A live event or another read may have updated this session in flight.
      if (current[key] === snapshot.previous[key]) merged[key] = status;
    }
  }
  return merged;
}

async function probeRelayTarget(connection: HostConnection, target: RelayTarget): Promise<TargetProbe> {
  const client = clientFor(connection, target.id);
  const [health, sessionsResult] = await Promise.allSettled([
    client.health(),
    client.listSessions(),
  ]);
  const sessions = sessionsResult.status === 'fulfilled'
    ? {
        status: 'fulfilled' as const,
        value: sessionsResult.value.map((session) => ({
          ...session,
          relayTargetID: target.id,
          relayTargetName: target.name,
        })),
      }
    : sessionsResult;
  const errors = [
    ...(health.status === 'rejected' ? [new Error(`Health check: ${errorMessage(health.reason)}`)] : []),
    ...(sessions.status === 'rejected' ? [new Error(`Session list: ${errorMessage(sessions.reason)}`)] : []),
  ];
  return { target, health, sessions, errors };
}

async function refreshTargetStatuses(
  connection: HostConnection,
  target: RelayTarget,
  sessions: Session[],
  get: StoreGet,
  onSnapshot: (snapshot: SessionStatusSnapshot) => void,
  stillCurrent: () => boolean,
) {
  const client = clientFor(connection, target.id);
  const scopes = new Map<string, Session[]>();
  // The index is already sorted by activity, so recent directories go first.
  for (const session of sessions) {
    const scope = JSON.stringify(workspaceQueryForSession(session));
    const group = scopes.get(scope) ?? [];
    group.push(session);
    scopes.set(scope, group);
  }
  const targetKey = JSON.stringify([connection.id, target.id]);
  const checks = statusScopeChecks.get(targetKey) ?? new Map<string, { attemptedAt: number; failed: boolean }>();
  statusScopeChecks.set(targetKey, checks);
  for (const scope of checks.keys()) if (!scopes.has(scope)) checks.delete(scope);
  const started = Date.now();
  const activeKey = get().activeSessionKey;
  const isActive = (group: Session[]) => group.some((session) =>
    sessionStateKey({ connectionId: connection.id, relayTargetID: target.id, sessionId: session.id }) === activeKey);
  const isRunning = (group: Session[]) => group.some((session) => {
    const status = get().sessionStatuses[sessionStateKey({ connectionId: connection.id, relayTargetID: target.id, sessionId: session.id })];
    return status && ('running' in status ? status.running : status.type !== 'idle');
  });
  const needsCheck = (scope: string, group: Session[]) => {
    const check = checks.get(scope);
    // Recent successful snapshots can serve repeated refreshes. Failed reads
    // back off too, rather than consuming every budget with the same directory.
    return !check || started - check.attemptedAt >= (!check.failed && (isActive(group) || isRunning(group)) ? 5_000 : 30_000);
  };
  const queue = [...scopes].filter(([scope, group]) => needsCheck(scope, group))
    .sort(([a, aGroup], [b, bGroup]) => Number(isActive(bGroup)) - Number(isActive(aGroup))
      || (checks.get(a)?.attemptedAt ?? -Infinity) - (checks.get(b)?.attemptedAt ?? -Infinity));
  const deadline = started + sessionStatusSyncBudgetMs;
  let checked = 0;
  for (const [scope, group] of queue) {
    if (!stillCurrent()) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const snapshot = await readSessionStatusSnapshot(client, {
        connectionId: connection.id, relayTargetID: target.id,
      }, group, get, { timeoutMs: Math.min(sessionStatusRequestTimeoutMs, remaining), retry: false });
      onSnapshot(snapshot);
      checks.set(scope, { attemptedAt: Date.now(), failed: false });
    } catch {
      // The final shortened request may hit our overall budget rather than
      // its normal timeout. Leave it queued, not recorded as a server failure.
      if (remaining < sessionStatusRequestTimeoutMs && Date.now() >= deadline) break;
      checks.set(scope, { attemptedAt: Date.now(), failed: true });
    }
    checked += 1;
    if (checked < queue.length && stillCurrent()) {
      // A sequential loop can still overwhelm FRP with fast requests.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(200, deadline - Date.now()))));
    }
  }
  return {
    failed: [...checks.values()].filter((check) => check.failed).length,
    // Expiring a successful snapshot does not undo completed discovery. Keep
    // initial progress separate from routine refreshes of known directories.
    deferred: queue.slice(checked).filter(([scope]) => !checks.has(scope)).length,
    stale: queue.slice(checked).some(([scope]) => checks.get(scope)?.failed === false),
  };
}

async function loadSession(
  ref: SessionRef,
  connection: HostConnection,
  generation: number,
  get: StoreGet,
  set: StoreSet,
) {
  const key = sessionStateKey(ref);
  const session = currentSessionForRef(get(), ref);
  if (!session) return;
  const client = clientFor(connection, ref.relayTargetID);
  const query = workspaceQueryForSession(session);
  const questionRevision = get().questionRevision;
  // Gates must appear as soon as the queue arrives, even if optional project
  // services (LSP/MCP/provider discovery) are still initializing.
  const permissionsRead = refreshSessionPermissions(ref, connection, get, set);
  const results = await Promise.allSettled([
    client.listMessagePage(ref.sessionId, { limit: DEFAULT_MESSAGE_PAGE_LIMIT }),
    client.getSessionDiff(ref.sessionId),
    client.getSessionTodos(ref.sessionId),
    client.getSessionContext(ref.sessionId),
    client.getLspStatus(query),
    client.getMcpStatus(query),
    client.listQuestions(query),
    client.listAgents(query),
    client.listConfiguredProviders(query),
    client.getConfig(query),
    client.listCommands(query),
    readSessionStatusSnapshot(client, ref, [session], get),
  ] as const);
  await permissionsRead;
  if (latestOpenGeneration.get(key) !== generation) return;

  const [messagesResult, diffsResult, todosResult, contextResult, lspResult, mcpResult, questionsResult, agentsResult, providersResult, configResult, commandsResult, statusResult] = results;
  const messages = messagesResult.status === 'fulfilled'
    ? mergeRestWithLiveMessages(messagesResult.value.items, get().messages[key] ?? [])
    : get().messages[key] ?? [];
  const directory = directoryForSession(session);
  const scopeKey = executionScopeKey(ref, directory);
  const previousContract = get().machineContracts[scopeKey];
  const previousContractState = get().contractLoadStates[scopeKey];
  const loadedContract = agentsResult.status === 'fulfilled' && providersResult.status === 'fulfilled'
    ? buildMachineContract({
        ref,
        session,
        agents: agentsResult.value,
        providers: providersResult.value,
        config: fulfilledOr(configResult, undefined),
        commands: fulfilledOr(commandsResult, previousContract?.commands ?? []),
        previous: previousContract,
      })
    : undefined;
  const contractError = executionContractLoadError(agentsResult, providersResult, loadedContract);
  const contract = loadedContract ?? previousContract;
  const attemptedAt = new Date().toISOString();
  const contractLoadState: MachineExecutionContractLoadState = loadedContract
    ? {
        status: 'fresh',
        attemptedAt,
        verifiedAt: loadedContract.fetchedAt,
        error: null,
      }
    : {
        status: previousContract ? 'stale' : 'error',
        attemptedAt,
        verifiedAt: previousContractState?.verifiedAt ?? previousContract?.fetchedAt,
        error: contractError,
      };
  const selection = loadedContract
    ? resolvePromptSelection({
        contract: contractForResolver(loadedContract),
        messages,
        session,
        stored: get().sessionSelections[key],
      })
    : undefined;
  const coreError = messagesResult.status === 'rejected' ? errorMessage(messagesResult.reason) : null;

  set((state) => {
    const isActive = state.activeSessionKey === key;
    const nextQuestions = questionsResult.status === 'fulfilled' && state.questionRevision === questionRevision
      ? mergeQuestionsForTarget(state.questions, ref, questionsResult.value)
      : state.questions;
    return {
      messages: { ...state.messages, [key]: messages },
      ...(statusResult.status === 'fulfilled'
        ? { sessionStatuses: mergeSessionStatusSnapshots(state.sessionStatuses, [statusResult.value]) }
        : {}),
      ...(messagesResult.status === 'fulfilled'
        ? {
            messageNextCursors: { ...state.messageNextCursors, [key]: messagesResult.value.nextCursor },
            olderMessageLoadStates: { ...state.olderMessageLoadStates, [key]: 'idle' as const },
            olderMessageErrors: { ...state.olderMessageErrors, [key]: null },
          }
        : {}),
      ...(diffsResult.status === 'fulfilled' ? { diffs: { ...state.diffs, [key]: diffsResult.value } } : {}),
      ...(todosResult.status === 'fulfilled' ? { todos: { ...state.todos, [key]: todosResult.value } } : {}),
      ...(contextResult.status === 'fulfilled' ? { sessionContexts: { ...state.sessionContexts, [key]: contextResult.value } } : {}),
      ...(lspResult.status === 'fulfilled' ? { lspStatuses: { ...state.lspStatuses, [key]: lspResult.value } } : {}),
      ...(mcpResult.status === 'fulfilled' ? { mcpStatuses: { ...state.mcpStatuses, [key]: mcpResult.value } } : {}),
      questions: nextQuestions,
      contractLoadStates: { ...state.contractLoadStates, [scopeKey]: contractLoadState },
      ...(contract
        ? {
            machineContracts: { ...state.machineContracts, [scopeKey]: contract },
            agents: { ...state.agents, [scopeKey]: contract.agents },
            commands: { ...state.commands, [scopeKey]: contract.commands },
          }
        : {}),
      ...(selection ? { sessionSelections: { ...state.sessionSelections, [key]: selection } } : {}),
      sessionLoadStates: { ...state.sessionLoadStates, [key]: coreError ? 'error' : 'idle' },
      sessionErrors: { ...state.sessionErrors, [key]: coreError },
      ...(isActive
        ? {
            loading: coreError ? 'error' : 'idle',
            error: coreError,
            activeAgentName: selection?.agentName ?? state.activeAgentName,
            activeVariant: selection?.variant,
            ...(isThinkingLevel(selection?.variant) ? { thinkingLevel: selection.variant } : {}),
          }
        : {}),
    };
  });
  if (selection?.agentName) {
    set((state) => ({ activeAgentByHost: { ...state.activeAgentByHost, [ref.connectionId]: selection.agentName } }));
    persistPromptPreferences(get());
  }
  persistTranscriptCache(ref, get());
}

async function openSessionInBackground(ref: SessionRef, connection: HostConnection, get: StoreGet, set: StoreSet) {
  const key = sessionStateKey(ref);
  const session = currentSessionForRef(get(), ref);
  if (!session) return;
  try {
    const permissionsRead = refreshSessionPermissions(ref, connection, get, set);
    const questionRevision = get().questionRevision;
    const client = clientFor(connection, ref.relayTargetID);
    const [messagesResult, questionsResult, statusResult] = await Promise.allSettled([
      client.listMessagePage(ref.sessionId, { limit: DEFAULT_MESSAGE_PAGE_LIMIT }),
      client.listQuestions(workspaceQueryForSession(session)),
      readSessionStatusSnapshot(client, ref, [session], get),
    ]);
    await permissionsRead;
    set((state) => ({
      ...(statusResult.status === 'fulfilled'
        ? { sessionStatuses: mergeSessionStatusSnapshots(state.sessionStatuses, [statusResult.value]) }
        : {}),
      ...(messagesResult.status === 'fulfilled'
        ? {
            messages: { ...state.messages, [key]: mergeRestWithLiveMessages(messagesResult.value.items, state.messages[key] ?? []) },
            ...(state.messageNextCursors[key] === undefined
              ? { messageNextCursors: { ...state.messageNextCursors, [key]: messagesResult.value.nextCursor } }
              : {}),
          }
        : {}),
      ...(questionsResult.status === 'fulfilled' && state.questionRevision === questionRevision
        ? { questions: mergeQuestionsForTarget(state.questions, ref, questionsResult.value) }
        : {}),
    }));
    persistTranscriptCache(ref, get());
  } catch {
    // The live stream remains authoritative; reconciliation failures do not
    // mislabel cached content as an offline transcript.
  }
}

function buildMachineContract(input: {
  ref: SessionRef;
  session: Session;
  agents: Agent[];
  providers?: ConfiguredProvidersResponse;
  config?: Record<string, unknown>;
  commands: Command[];
  previous?: MachineExecutionContract;
}): MachineExecutionContract | undefined {
  const providers = input.providers?.providers ?? [];
  const providerDefaults = input.providers?.default ?? {};
  const agents = input.agents;
  const hasSelectableAgent = agents.some((agent) => !agent.hidden && agent.mode !== 'subagent');
  const hasConfiguredModel = flattenConfiguredModels({ providers, default: providerDefaults }).length > 0;
  if (!hasSelectableAgent || !hasConfiguredModel) return undefined;
  return {
    connectionId: input.ref.connectionId,
    relayTargetID: input.ref.relayTargetID,
    relayTargetName: input.session.relayTargetName,
    directory: directoryForSession(input.session),
    agents,
    providers,
    providerDefaults,
    configModel: configModelValue(input.config) ?? input.previous?.configModel,
    commands: input.commands,
    fetchedAt: new Date().toISOString(),
  };
}

function executionContractLoadError(
  agentsResult: PromiseSettledResult<Agent[]>,
  providersResult: PromiseSettledResult<ConfiguredProvidersResponse>,
  contract?: MachineExecutionContract,
) {
  if (contract) return null;
  const errors: string[] = [];
  if (agentsResult.status === 'rejected') errors.push(`agents: ${errorMessage(agentsResult.reason)}`);
  if (providersResult.status === 'rejected') errors.push(`models: ${errorMessage(providersResult.reason)}`);
  if (errors.length > 0) return `Execution contract verification failed (${errors.join('; ')}).`;
  const hasSelectableAgent = agentsResult.status === 'fulfilled'
    && agentsResult.value.some((agent) => !agent.hidden && agent.mode !== 'subagent');
  if (!hasSelectableAgent) return 'Execution contract verification returned no selectable primary agent.';
  return 'Execution contract verification returned no configured model.';
}

function contractDispatchBlockedMessage(state?: MachineExecutionContractLoadState) {
  if (!state || state.status === 'unverified') {
    return 'Execution contract is unverified. Reload the session before sending.';
  }
  if (state.status === 'loading') {
    return 'Execution contract is still loading. Wait for verification before sending.';
  }
  if (state.status === 'stale') {
    return `Execution contract is stale and must be reverified before sending.${state.error ? ` ${state.error}` : ''}`;
  }
  if (state.status === 'error') {
    return `Execution contract could not be verified; sending is blocked.${state.error ? ` ${state.error}` : ''}`;
  }
  return 'Execution contract is unavailable. Reload the session before sending.';
}

function contractForResolver(contract: MachineExecutionContract) {
  return {
    agents: contract.agents,
    providers: contract.providers,
    providerDefaults: contract.providerDefaults,
    configModel: contract.configModel,
  };
}

function selectionContext(input: SessionInput, state: MobileStore) {
  const ref = resolveSessionInput(input, state);
  const session = currentSessionForRef(state, ref);
  if (!session) throw new Error('Session is no longer available');
  const key = sessionStateKey(ref);
  const scopeKey = executionScopeKey(ref, directoryForSession(session));
  const contract = state.machineContracts[scopeKey];
  if (!contract) throw new Error('Machine execution contract is not loaded');
  return { ref, session, key, scopeKey, contract };
}

function applySelection(
  set: StoreSet,
  get: StoreGet,
  ref: SessionRef,
  selection: PromptSelection,
  clearVariant = false,
) {
  const key = sessionStateKey(ref);
  const normalized: PromptSelection = clearVariant && selection.variant === undefined
    ? { agentName: selection.agentName, model: selection.model }
    : selection;
  set((state) => ({
    sessionSelections: { ...state.sessionSelections, [key]: normalized },
    ...(state.activeSessionKey === key
      ? {
          activeAgentName: normalized.agentName ?? null,
          activeVariant: normalized.variant,
          ...(isThinkingLevel(normalized.variant) ? { thinkingLevel: normalized.variant } : {}),
        }
      : {}),
    ...(normalized.agentName
      ? { activeAgentByHost: { ...state.activeAgentByHost, [ref.connectionId]: normalized.agentName } }
      : {}),
  }));
  persistPromptPreferences(get());
}

function dispatchPrompt(
  client: OpenCodeClient,
  sessionId: string,
  text: string,
  promptMode: PromptMode,
  dispatch: PromptDispatchOptions,
) {
  if (promptMode === 'shell') {
    return client.runShell(sessionId, stripShellBang(text), {
      agent: dispatch.agent,
      model: dispatch.model,
      directory: dispatch.directory,
    });
  }
  const slash = parseSlashCommand(text);
  if (slash) {
    return client.sendCommand(sessionId, slash.command, slash.args, dispatch);
  }
  return client.sendAsync(sessionId, [{ type: 'text', text }], dispatch);
}

function clientFor(connection: HostConnection, relayTargetID?: string) {
  return new OpenCodeClient(connection, {
    relayTargetID: relayTargetID && relayTargetID !== DIRECT_RELAY_TARGET_ID ? relayTargetID : undefined,
  });
}

function activeConnection(state: Pick<MobileStore, 'connections' | 'activeConnectionId'>) {
  return state.connections.find((connection) => connection.id === state.activeConnectionId);
}

function connectionForRef(state: Pick<MobileStore, 'connections'>, ref: SessionRef) {
  return state.connections.find((connection) => connection.id === ref.connectionId);
}

function currentSessionForRef(state: Pick<MobileStore, 'sessions'>, ref: SessionRef) {
  return (state.sessions[ref.connectionId] ?? []).find((session) => {
    const targetID = session.relayTargetID ?? DIRECT_RELAY_TARGET_ID;
    return targetID === ref.relayTargetID && session.id === ref.sessionId;
  });
}

function resolveSessionInput(input: SessionInput, state: MobileStore): SessionRef {
  if (typeof input !== 'string') {
    if (!input.connectionId || !input.relayTargetID || !input.sessionId) throw new Error('Incomplete session routing identity');
    return input;
  }
  const connectionId = state.activeConnectionId;
  if (!connectionId) throw new Error('No active relay connection');
  const candidates = (state.sessions[connectionId] ?? [])
    .filter((session) => session.id === input)
    .map((session) => sessionRefFor(connectionId, session));
  const unique = [...new Map(candidates.map((candidate) => [sessionStateKey(candidate), candidate])).values()];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) throw new Error(`Session ID ${input} is ambiguous across relay machines`);
  throw new Error(`Session ${input} is not present on the active relay`);
}

function requireSessionContext(input: SessionInput, state: MobileStore) {
  const ref = resolveSessionInput(input, state);
  const connection = connectionForRef(state, ref);
  const session = currentSessionForRef(state, ref);
  if (!connection || !session) throw new Error('Session routing target is no longer available');
  return { ref, connection, session };
}

function workspaceQueryForSession(session: Session | undefined) {
  return {
    directory: session ? directoryForSession(session) : undefined,
    workspace: session?.workspaceID ?? undefined,
  };
}

function directoryForSession(session: Session) {
  return session.location?.directory ?? session.directory ?? session.path;
}

function normalizeTargets(targets: RelayTarget[]): RelayTarget[] {
  // A relay that explicitly reports zero targets has no authorized machine.
  // Never fall through to its implicit/default upstream. Direct OpenCode
  // servers are recognized only by a 404 from /relay/targets below.
  return targets.filter((target) => target.id && target.name);
}

function targetListFailureFallback(error: unknown, connection: HostConnection): RelayTarget[] {
  if (error instanceof OpenCodeRequestError && error.status === 404) {
    return [{ id: DIRECT_RELAY_TARGET_ID, name: connection.name }];
  }
  throw error;
}

function aggregateHealth(probes: TargetProbe[]): HealthResponse;
function aggregateHealth(probes: TargetProbe[]): HealthResponse {
  const values = probes;
  const healthy = values.find(
    (probe): probe is TargetProbe & { health: PromiseFulfilledResult<HealthResponse> } =>
      probe.health.status === 'fulfilled' && probe.health.value.healthy,
  );
  if (healthy) return healthy.health.value;
  return { healthy: values.some((probe) => probe.sessions.status === 'fulfilled'), version: 'unknown' };
}

function markReachable(connections: HostConnection[], id: string, health: HealthResponse) {
  return connections.map((connection) =>
    connection.id === id
      ? { ...connection, isReachable: health.healthy, lastConnected: new Date().toISOString() }
      : connection,
  );
}

function applyRelayDeviceIdentity(connection: HostConnection, identity: RelayDeviceIdentity): HostConnection {
  return {
    ...connection,
    name: identity.displayName,
    relayDeviceID: identity.clientID,
    relayNameRevision: identity.displayNameRevision,
    relayNameUpdatedAt: identity.displayNameUpdatedAt,
  };
}

function applySessionUpdate(state: MobileStore, ref: SessionRef, session: Session): Pick<MobileStore, 'sessions' | 'projects'> {
  const current = state.sessions[ref.connectionId] ?? [];
  const normalized = { ...session, relayTargetID: ref.relayTargetID };
  const exists = current.some((item) => sessionStateKey(sessionRefFor(ref.connectionId, item)) === sessionStateKey(ref));
  const sessions = exists
    ? current.map((item) =>
        sessionStateKey(sessionRefFor(ref.connectionId, item)) === sessionStateKey(ref)
          ? { ...item, ...normalized, revert: normalized.revert }
          : item,
      )
    : [normalized, ...current];
  sessions.sort(compareSessionsByRecency);
  return {
    sessions: { ...state.sessions, [ref.connectionId]: sessions },
    projects: { ...state.projects, [ref.connectionId]: groupSessionsByDirectory(sessions) },
  };
}

/**
 * Pulls a readable sentence out of an error event.
 *
 * The server reports a failed turn as an event, not as a failed request, so a
 * model that cannot run produced no message, no status change the app noticed,
 * and nothing on screen. Its shape is `{ name, data: { message } }`, but an
 * unrecognised one must still say something rather than fall back to silence.
 */
export function serverEventErrorText(properties: Record<string, unknown>): string {
  const candidates = [properties.error, properties.data, properties];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : undefined;
    const message = [data?.message, record.message, record.name]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (message) return message;
  }
  return 'The machine reported an error with no description.';
}

function applyServerEvent(state: MobileStore, scopeRef: SessionRef, event: ServerEvent): Partial<MobileStore> {
  const properties = recordValue(event.properties);
  if (!properties) return {};
  const sessionId = sessionIdFromServerEvent(event);
  const ref = sessionId ? { ...scopeRef, sessionId } : scopeRef;
  const key = sessionStateKey(ref);

  if (event.type === 'session.error' || event.type === 'message.error') {
    const text = serverEventErrorText(properties);
    return {
      sessionErrors: { ...state.sessionErrors, [key]: text },
      // Leave the session marked busy and the spinner never stops.
      sessionStatuses: { ...state.sessionStatuses, [key]: { type: 'idle' as const } },
    };
  }
  if (event.type === 'permission.asked') {
    const request = properties as unknown as PermissionRequest;
    if (!request.id || !request.sessionID || !request.permission || !Array.isArray(request.patterns)) return {};
    return {
      permissions: { ...state.permissions, [key]: [...(state.permissions[key] ?? []).filter((item) => item.id !== request.id), request] },
      permissionErrors: { ...state.permissionErrors, [key]: null },
    };
  }
  if (event.type === 'permission.replied') {
    const requestID = stringValue(properties.requestID);
    if (!sessionId || !requestID) return {};
    return {
      permissions: { ...state.permissions, [key]: (state.permissions[key] ?? []).filter((item) => item.id !== requestID) },
    };
  }

  if (event.type === 'question.asked') {
    const request = properties as unknown as QuestionRequest;
    if (!request.id || !request.sessionID) return {};
    const requestRef = { ...scopeRef, sessionId: request.sessionID };
    const requestKey = sessionStateKey(requestRef);
    const existing = state.questions[requestKey] ?? [];
    return {
      questions: { ...state.questions, [requestKey]: [...existing.filter((item) => item.id !== request.id), request] },
      questionRevision: state.questionRevision + 1,
    };
  }
  if (event.type === 'question.replied' || event.type === 'question.rejected') {
    const requestID = stringValue(properties.requestID);
    if (!sessionId || !requestID) return {};
    return {
      questions: { ...state.questions, [key]: (state.questions[key] ?? []).filter((item) => item.id !== requestID) },
      questionRevision: state.questionRevision + 1,
    };
  }
  if (!sessionId) return {};

  if (event.type === 'session.updated') {
    const info = recordValue(properties.info);
    return info
      ? applySessionUpdate(state, ref, { ...(info as unknown as Session), relayTargetID: ref.relayTargetID })
      : {};
  }
  if (event.type === 'session.deleted') {
    const sessions = (state.sessions[ref.connectionId] ?? []).filter(
      (session) => sessionStateKey(sessionRefFor(ref.connectionId, session)) !== key,
    );
    return {
      sessions: { ...state.sessions, [ref.connectionId]: sessions },
      projects: { ...state.projects, [ref.connectionId]: groupSessionsByDirectory(sessions) },
      messages: omitRecordKey(state.messages, key),
      diffs: omitRecordKey(state.diffs, key),
      todos: omitRecordKey(state.todos, key),
      questions: omitRecordKey(state.questions, key),
      permissions: omitRecordKey(state.permissions, key),
      permissionErrors: omitRecordKey(state.permissionErrors, key),
    };
  }
  if (event.type === 'session.status') {
    const status = recordValue(properties.status) as SessionStatus | undefined;
    return status ? { sessionStatuses: { ...state.sessionStatuses, [key]: status } } : {};
  }
  if (event.type === 'session.diff') {
    return Array.isArray(properties.diff) ? { diffs: { ...state.diffs, [key]: properties.diff as FileDiff[] } } : {};
  }
  if (event.type === 'todo.updated') {
    return Array.isArray(properties.todos) ? { todos: { ...state.todos, [key]: properties.todos as TodoItem[] } } : {};
  }
  if (event.type === 'message.updated') {
    const info = recordValue(properties.info);
    if (!info || typeof info.id !== 'string') return {};
    return { messages: { ...state.messages, [key]: upsertMessageInfo(state.messages[key] ?? [], sessionId, info) } };
  }
  if (event.type === 'message.removed') {
    const messageID = stringValue(properties.messageID);
    return messageID
      ? { messages: { ...state.messages, [key]: (state.messages[key] ?? []).filter((message) => message.info.id !== messageID) } }
      : {};
  }
  if (event.type === 'message.part.updated') {
    const part = recordValue(properties.part);
    const messageId = stringValue(part?.messageID);
    if (!part || !messageId) return {};
    return {
      messages: {
        ...state.messages,
        [key]: upsertMessagePart(state.messages[key] ?? [], sessionId, messageId, part as MessagePart),
      },
    };
  }
  if (event.type === 'message.part.removed') {
    const messageID = stringValue(properties.messageID);
    const partID = stringValue(properties.partID);
    if (!messageID || !partID) return {};
    return {
      messages: {
        ...state.messages,
        [key]: (state.messages[key] ?? []).map((message) =>
          message.info.id === messageID
            ? { ...message, parts: message.parts.filter((part) => stringValue((part as Record<string, unknown>).id) !== partID) }
            : message,
        ),
      },
    };
  }
  return {};
}

function mergeRestWithLiveMessages(rest: MessageWithParts[], live: MessageWithParts[]) {
  const liveById = new Map(live.map((message) => [message.info.id, message]));
  const merged = rest.map((message) => {
    const current = liveById.get(message.info.id);
    if (!current) return message;
    liveById.delete(message.info.id);
    return {
      info: { ...message.info, ...current.info },
      parts: mergeMessageParts(message.parts, current.parts),
    };
  });
  return sortMessagesChronologically([...merged, ...liveById.values()]);
}

function mergeMessageParts(rest: MessagePart[], live: MessagePart[]) {
  const liveById = new Map<string, MessagePart>();
  const liveWithoutId: MessagePart[] = [];
  for (const part of live) {
    const id = stringValue((part as Record<string, unknown>).id);
    if (id) liveById.set(id, part);
    else liveWithoutId.push(part);
  }
  const merged = rest.map((part) => {
    const id = stringValue((part as Record<string, unknown>).id);
    const current = id ? liveById.get(id) : undefined;
    if (!current) return part;
    liveById.delete(id!);
    return { ...part, ...current } as MessagePart;
  });
  return [...merged, ...liveById.values(), ...liveWithoutId];
}

function upsertMessageInfo(messages: MessageWithParts[], sessionId: string, info: Record<string, unknown>) {
  const messageId = stringValue(info.id);
  if (!messageId) return messages;
  const nextInfo = { ...info, sessionID: stringValue(info.sessionID) ?? sessionId } as MessageWithParts['info'];
  const existing = messages.find((message) => message.info.id === messageId);
  if (!existing) return sortMessagesChronologically([...messages, { info: nextInfo, parts: [] }]);
  return sortMessagesChronologically(messages.map((message) =>
    message.info.id === messageId ? { ...message, info: { ...message.info, ...nextInfo } } : message,
  ));
}

function upsertMessagePart(messages: MessageWithParts[], sessionId: string, messageId: string, part: MessagePart) {
  const index = messages.findIndex((message) => message.info.id === messageId);
  const target = index >= 0
    ? messages[index]
    : { info: { id: messageId, sessionID: sessionId, role: 'assistant' as const }, parts: [] };
  const partId = stringValue((part as Record<string, unknown>).id);
  const partIndex = partId
    ? target.parts.findIndex((item) => stringValue((item as Record<string, unknown>).id) === partId)
    : -1;
  const parts = partIndex >= 0
    ? target.parts.map((item, itemIndex) => itemIndex === partIndex ? { ...item, ...part } : item)
    : [...target.parts, part];
  const updated = { ...target, parts };
  if (index < 0) return [...messages, updated];
  return messages.map((message, messageIndex) => messageIndex === index ? updated : message);
}

async function refreshSessionPermissions(ref: SessionRef, connection: HostConnection, get: StoreGet, set: StoreSet) {
  const key = sessionStateKey(ref);
  const session = currentSessionForRef(get(), ref);
  if (!session) return;
  const previous = get().permissions[key];
  const revision = (permissionReads.get(key) ?? 0) + 1;
  permissionReads.set(key, revision);
  const current = () => permissionReads.get(key) === revision
    && Boolean(currentSessionForRef(get(), ref))
    && get().connections.some((item) => item.id === connection.id);
  try {
    const requests = await clientFor(connection, ref.relayTargetID).listPermissions(workspaceQueryForSession(session));
    if (!current()) return;
    set((state) => state.permissions[key] === previous ? {
      permissions: { ...state.permissions, [key]: requests.filter((request) => request.sessionID === ref.sessionId) },
      permissionErrors: { ...state.permissionErrors, [key]: null },
    } : {});
  } catch (error) {
    if (!current()) return;
    set((state) => state.permissions[key] === previous ? {
      permissionErrors: { ...state.permissionErrors, [key]: `Could not check pending permissions: ${errorMessage(error)}` },
    } : {});
  }
}

function mergeQuestionsForTarget(
  current: Record<string, QuestionRequest[]>,
  scopeRef: SessionRef,
  questions: QuestionRequest[],
) {
  const next = { ...current };
  const grouped = new Map<string, QuestionRequest[]>();
  for (const question of questions) {
    const key = sessionStateKey({ ...scopeRef, sessionId: question.sessionID });
    grouped.set(key, [...(grouped.get(key) ?? []), question]);
  }
  for (const [key, value] of grouped) next[key] = value;
  const activeKey = sessionStateKey(scopeRef);
  if (!grouped.has(activeKey)) next[activeKey] = [];
  return next;
}

function fulfilledOr<T>(result: PromiseSettledResult<T>, fallback: T): T;
function fulfilledOr<T>(result: PromiseSettledResult<T>, fallback: T | undefined): T | undefined;
function fulfilledOr<T>(result: PromiseSettledResult<T>, fallback: T | undefined) {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function configModelValue(config?: Record<string, unknown>) {
  const model = config?.model;
  if (typeof model === 'string') return model;
  const value = recordValue(model);
  const providerID = stringValue(value?.providerID);
  const modelID = stringValue(value?.modelID);
  return providerID && modelID ? `${providerID}/${modelID}` : undefined;
}

function migrateSessionCache(cache: SessionCacheSnapshot) {
  const refsByBareID = new Map<string, SessionRef[]>();
  for (const [connectionId, sessions] of Object.entries(cache.sessions)) {
    for (const session of sessions) {
      const ref = sessionRefFor(connectionId, session);
      refsByBareID.set(session.id, [...(refsByBareID.get(session.id) ?? []), ref]);
    }
  }
  const migrateRecord = <T>(record: Record<string, T>) => {
    const next: Record<string, T> = {};
    for (const [oldKey, value] of Object.entries(record)) {
      const decoded = decodeSessionStateKey(oldKey);
      if (decoded) {
        next[sessionStateKey(decoded)] = value;
        continue;
      }
      const candidates = refsByBareID.get(oldKey) ?? [];
      if (candidates.length === 1) next[sessionStateKey(candidates[0])] = value;
    }
    return next;
  };
  const statuses: Record<string, SessionStatus> = {};
  for (const [connectionId, hostStatuses] of Object.entries(cache.sessionStatuses)) {
    for (const [oldKey, status] of Object.entries(hostStatuses)) {
      const decoded = decodeSessionStateKey(oldKey);
      if (decoded) {
        statuses[sessionStateKey(decoded)] = status;
        continue;
      }
      const candidates = (refsByBareID.get(oldKey) ?? []).filter((ref) => ref.connectionId === connectionId);
      if (candidates.length === 1) statuses[sessionStateKey(candidates[0])] = status;
    }
  }
  const messages = migrateRecord(cache.messages);
  for (const [key, transcript] of Object.entries(messages)) {
    messages[key] = sortMessagesChronologically(transcript);
  }
  return {
    sessions: cache.sessions,
    projects: cache.projects,
    sessionStatuses: statuses,
    messages,
    diffs: migrateRecord(cache.diffs),
    todos: migrateRecord(cache.todos),
    sessionContexts: migrateRecord(cache.sessionContexts),
    lspStatuses: migrateRecord(cache.lspStatuses),
    mcpStatuses: migrateRecord(cache.mcpStatuses),
  };
}

function persistHostCache(connectionId: string, state: MobileStore) {
  cachePersistence.schedule(`host:${connectionId}`, {
    kind: 'host',
    connectionId,
    cache: {
      sessions: state.sessions[connectionId] ?? [],
      projects: state.projects[connectionId] ?? [],
      sessionStatuses: compositeValuesForConnection(state.sessionStatuses, connectionId),
      agents: [],
      commands: [],
    },
  });
}

function persistTranscriptCache(ref: SessionRef, state: MobileStore) {
  const key = sessionStateKey(ref);
  cachePersistence.schedule(`session:${key}`, {
    kind: 'session',
    key,
    cache: {
      messages: sortMessagesChronologically(state.messages[key] ?? []),
      diffs: state.diffs[key] ?? [],
      todos: state.todos[key] ?? [],
      context: state.sessionContexts[key] ?? [],
      lspStatus: state.lspStatuses[key] ?? [],
      mcpStatus: state.mcpStatuses[key] ?? {},
    },
  });
}

function compositeValuesForConnection<T>(record: Record<string, T>, connectionId: string) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => decodeSessionStateKey(key)?.connectionId === connectionId));
}

function omitCompositeConnection<T>(record: Record<string, T>, connectionId: string) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => decodeSessionStateKey(key)?.connectionId !== connectionId));
}

function omitScopeConnection<T>(record: Record<string, T>, connectionId: string) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => {
    try {
      const value = JSON.parse(key) as unknown;
      return !Array.isArray(value) || value[0] !== connectionId;
    } catch {
      return true;
    }
  }));
}

function omitRecordKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

function omitKeys<T>(record: Partial<Record<string, T>>, keys: string[]) {
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

function stripShellBang(text: string) {
  return text.startsWith('!') ? text.slice(1).trimStart() : text;
}

function parseSlashCommand(text: string) {
  const match = /^\/([A-Za-z0-9_.:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { command: match[1], args: match[2]?.trim() ?? '' } : null;
}

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeConnectionUrl(url: string) {
  const trimmed = url.trim();
  try {
    return new URL(trimmed).toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sessionIdFromServerEvent(event: ServerEvent) {
  const properties = recordValue(event.properties);
  const info = recordValue(properties?.info);
  const part = recordValue(properties?.part);
  return stringValue(properties?.sessionID)
    ?? stringValue(info?.sessionID)
    ?? stringValue(part?.sessionID)
    ?? (event.type.startsWith('session.') ? stringValue(info?.id) : undefined);
}

// The relay answers a rejected path with a bare token. Shown as-is it reads as
// a demand for a directory rather than as "that path is not one".
const RELAY_ERROR_TEXT: Record<string, string> = {
  directory_forbidden: 'That working directory is not usable on this machine. Pick one of the offered directories, or leave it empty to use the machine default. Paths must be absolute, and "~" is not expanded.',
  target_forbidden: 'This device is not authorized for that machine.',
};

function errorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  for (const [token, text] of Object.entries(RELAY_ERROR_TEXT)) {
    if (raw.includes(token)) return text;
  }
  return raw;
}

function summarizeSyncIssues(issues: string[]) {
  const unique = [...new Set(issues.map((issue) => issue.trim()).filter(Boolean))];
  if (unique.length === 0) return null;
  const summary = `Sync incomplete: ${unique.join('; ')}`;
  return summary.length <= 600 ? summary : `${summary.slice(0, 597)}...`;
}

function persistPromptPreferences(state: MobileStore) {
  void savePromptPreferences({
    activeAgentByHost: state.activeAgentByHost,
    thinkingLevel: state.thinkingLevel,
    promptMode: state.promptMode,
  }).catch(() => undefined);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'max';
}

export function partToText(part: MessagePart): string {
  if (part.type === 'text') return String(part.text);
  if (part.type === 'reasoning') return typeof part.text === 'string' ? part.text : JSON.stringify(part);
  if (part.type === 'tool' || part.type === 'tool_use' || part.type === 'tool_result') return JSON.stringify(part, null, 2);
  if (part.type === 'file') {
    const filename = typeof part.filename === 'string' ? part.filename : undefined;
    const url = typeof part.url === 'string' ? part.url : undefined;
    return filename ?? url ?? '[file]';
  }
  return JSON.stringify(part);
}
