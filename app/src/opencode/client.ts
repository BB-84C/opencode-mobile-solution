import { createSseParser, type ServerEvent } from './sse';
import type {
  Agent,
  Command,
  ConfiguredProvidersResponse,
  FileReference,
  FileDiff,
  HealthResponse,
  HostConnection,
  LspStatus,
  McpStatusMap,
  MessagePage,
  MessagePart,
  MessageWithParts,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  PromptDispatchOptions,
  Project,
  QuestionReplyBody,
  QuestionRequest,
  RelayTarget,
  RelayDeviceIdentity,
  Session,
  SessionContextMessage,
  SessionStatus,
  TodoItem,
} from './types';

type FetchLike = typeof fetch;

export interface WorkspaceQuery {
  directory?: string;
  workspace?: string;
  limit?: number;
  type?: 'file' | 'directory';
}

export interface RequestPolicy {
  timeoutMs?: number;
  retry?: boolean;
}

export interface OpenCodeClientOptions {
  fetch?: FetchLike;
  release?: boolean;
  relayTargetID?: string;
  timeoutMs?: number;
}

export interface EventSubscriptionOptions {
  firstByteTimeoutMs?: number;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  idleTimeoutMs?: number;
  random?: () => number;
  onReconnect?: () => void | Promise<void>;
  onConnectionState?: (state: EventConnectionState, error?: unknown) => void;
  directory?: string;
}

export type EventConnectionState = 'connecting' | 'live' | 'reconciling' | 'offline';

export const DEFAULT_MESSAGE_PAGE_LIMIT = 50;
// The relay can expose well over a thousand historical sessions per machine.
// A small page makes first sync visibly stall because cursors are sequential;
// 1000 is accepted by the verified relay contract and still keeps paging safe.
export const DEFAULT_SESSION_PAGE_LIMIT = 1_000;

export class OpenCodeRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly transient = false,
  ) {
    super(message);
    this.name = 'OpenCodeRequestError';
  }
}

export function isTransientOpenCodeError(error: unknown) {
  if (error instanceof OpenCodeRequestError) return error.transient;
  if (isAbortError(error)) return true;
  // Expo fetch wraps native transport failures in Error, rather than TypeError.
  if (error instanceof Error && error.message.startsWith('fetch failed:')) return true;
  return error instanceof TypeError || (typeof error === 'object' && error !== null && 'code' in error);
}

export interface OpenCodeClientLike {
  health(): Promise<HealthResponse>;
  listProjects(): Promise<Project[]>;
  listSessions(): Promise<Session[]>;
  listRelayTargets?(): Promise<RelayTarget[]>;
  getSession(sessionId: string): Promise<Session>;
  updateSession(sessionId: string, patch: Pick<Session, 'title'>): Promise<Session>;
  forkSession(sessionId: string, messageId?: string): Promise<Session>;
  shareSession(sessionId: string): Promise<Session>;
  compactSession(sessionId: string, model: ModelRef): Promise<void>;
  revertMessage(sessionId: string, messageId: string): Promise<Session>;
  unrevertSession(sessionId: string): Promise<Session>;
  getSessionStatus(options?: WorkspaceQuery): Promise<Record<string, SessionStatus>>;
  getLspStatus(options?: WorkspaceQuery): Promise<LspStatus[]>;
  getMcpStatus(options?: WorkspaceQuery): Promise<McpStatusMap>;
  listMessages(sessionId: string, limit?: number, before?: string): Promise<MessageWithParts[]>;
  listMessagePage(sessionId: string, options?: { limit?: number; before?: string }): Promise<MessagePage>;
  getSessionContext(sessionId: string): Promise<SessionContextMessage[]>;
  getSessionTodos(sessionId: string): Promise<TodoItem[]>;
  createSession(title?: string, directory?: string): Promise<Session>;
  sendMessage(sessionId: string, parts: MessagePart[]): Promise<MessageWithParts>;
  sendAsync(sessionId: string, parts: MessagePart[], options?: PromptDispatchOptions): Promise<void>;
  sendCommand(sessionId: string, command: string, args: string, options?: PromptDispatchOptions): Promise<void>;
  runShell(sessionId: string, command: string, options: Pick<PromptDispatchOptions, 'agent' | 'model' | 'directory'>): Promise<void>;
  abortSession(sessionId: string): Promise<void>;
  listAgents(options?: WorkspaceQuery): Promise<Agent[]>;
  listCommands(options?: WorkspaceQuery): Promise<Command[]>;
  listConfiguredProviders?(options?: WorkspaceQuery): Promise<ConfiguredProvidersResponse>;
  getConfig?(options?: WorkspaceQuery): Promise<Record<string, unknown>>;
  findFiles(query: string, options?: WorkspaceQuery): Promise<FileReference[]>;
  getSessionDiff(sessionId: string, messageId?: string): Promise<FileDiff[]>;
  listPermissions(options?: WorkspaceQuery): Promise<PermissionRequest[]>;
  respondToPermission(sessionId: string, permissionId: string, reply: PermissionReply, options?: WorkspaceQuery): Promise<void>;
  listQuestions(options?: WorkspaceQuery): Promise<QuestionRequest[]>;
  respondToQuestion(requestId: string, reply: QuestionReplyBody, options?: WorkspaceQuery): Promise<void>;
  rejectQuestion(requestId: string, options?: WorkspaceQuery): Promise<void>;
}

export function buildAuthHeaders(connection: HostConnection): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (connection.authType === 'bearer' && connection.token) {
    headers.Authorization = `Bearer ${connection.token}`;
  }

  if (connection.authType === 'basic' && connection.username !== undefined && connection.password !== undefined) {
    headers.Authorization = `Basic ${encodeBase64(`${connection.username}:${connection.password}`)}`;
  }

  return headers;
}

function encodeBase64(value: string) {
  if (typeof btoa === 'function') return btoa(value);
  return Buffer.from(value, 'utf8').toString('base64');
}

function compactObject<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function workspaceQuery(options: WorkspaceQuery) {
  const params = new URLSearchParams();
  if (options.directory) params.set('directory', options.directory);
  if (options.workspace) params.set('workspace', options.workspace);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.type) params.set('type', options.type);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function findFileQuery(query: string, options: WorkspaceQuery) {
  const params = new URLSearchParams();
  params.set('query', query);
  if (options.directory) params.set('directory', options.directory);
  if (options.workspace) params.set('workspace', options.workspace);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.type) params.set('type', options.type);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export class OpenCodeClient implements OpenCodeClientLike {
  private readonly fetchImpl: FetchLike;
  private readonly release: boolean;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly relayTargetID?: string;

  constructor(
    private readonly connection: HostConnection,
    options: OpenCodeClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.release = options.release ?? false;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.relayTargetID = options.relayTargetID;
    this.baseUrl = connection.url.replace(/\/+$/, '');
  }

  health() {
    return this.request<HealthResponse>('/global/health');
  }

  async healthAcrossRelayTargets(initialError?: unknown) {
    const targets = await this.listRelayTargets().catch(() => []);
    if (targets.length === 0) {
      if (initialError) throw initialError;
      return this.health();
    }
    const results = await Promise.allSettled(
      targets.map((target) =>
        new OpenCodeClient(this.connection, {
          fetch: this.fetchImpl,
          release: this.release,
          relayTargetID: target.id,
          timeoutMs: this.timeoutMs,
        }).health(),
      ),
    );
    const reachable = results.find((result): result is PromiseFulfilledResult<HealthResponse> => result.status === 'fulfilled');
    if (reachable) return reachable.value;
    throw (results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined)?.reason
      ?? initialError
      ?? new Error('No authorized relay machine is reachable');
  }

  listProjects() {
    return this.request<Project[]>('/project');
  }

  async listSessions() {
    const sessions = new Map<string, Session>();
    const visitedCursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      const params = new URLSearchParams({ limit: String(DEFAULT_SESSION_PAGE_LIMIT) });
      if (cursor) params.set('cursor', cursor);
      const page = await this.request<ApiSessionPage>(`/api/session?${params.toString()}`);
      const items = Array.isArray(page.data) ? page.data : [];

      for (const session of items) {
        if (!session?.id || sessions.has(session.id)) continue;
        sessions.set(session.id, normalizeEnumeratedSession(session, this.relayTargetID));
      }

      const next = page.cursor?.next;
      // The relay may cap a requested page below our preferred limit. Its
      // cursor is authoritative; stopping on item count would silently omit
      // older sessions when a server-side cap is active.
      if (!next || visitedCursors.has(next)) break;
      visitedCursors.add(next);
      cursor = next;
    }

    return [...sessions.values()].sort(compareSessionsByRecency);
  }

  listRelayTargets() {
    return this.request<{ targets: RelayTarget[] }>('/relay/targets').then((response) => response.targets ?? []);
  }

  getRelayDeviceIdentity() {
    return this.request<{ device: RelayDeviceIdentity }>('/api/pairing/me').then((value) => value.device);
  }

  renameRelayDevice(displayName: string) {
    return this.request<{ renamed: true; device: RelayDeviceIdentity }>('/api/pairing/name', {
      method: 'POST',
      body: { displayName },
    }).then((value) => value.device);
  }

  async listSessionsAcrossRelayTargets() {
    const targets = await this.listRelayTargets().catch(() => []);
    if (targets.length === 0) return this.listSessions();

    const results = await Promise.allSettled(
      targets.map(async (target) => {
        const client = new OpenCodeClient(this.connection, {
          fetch: this.fetchImpl,
          release: this.release,
          relayTargetID: target.id,
          timeoutMs: this.timeoutMs,
        });
        const sessions = await client.listSessions();
        return sessions.map((session) => ({
          ...session,
          relayTargetID: target.id,
          relayTargetName: target.name,
        }));
      }),
    );
    const sessions = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    if (sessions.length > 0 || results.some((result) => result.status === 'fulfilled')) {
      return sessions.sort(compareSessionsByRecency);
    }
    throw (results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined)?.reason
      ?? new Error('No authorized relay machine is reachable');
  }

  getSession(sessionId: string) {
    return this.request<Session>(`/session/${encodeURIComponent(sessionId)}`);
  }

  updateSession(sessionId: string, patch: Pick<Session, 'title'>) {
    return this.request<Session>(`/session/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: compactObject(patch),
    });
  }

  forkSession(sessionId: string, messageId?: string) {
    return this.request<Session>(`/session/${encodeURIComponent(sessionId)}/fork`, {
      method: 'POST',
      body: compactObject({ messageID: messageId }),
    });
  }

  shareSession(sessionId: string) {
    return this.request<Session>(`/session/${encodeURIComponent(sessionId)}/share`, {
      method: 'POST',
    });
  }

  async compactSession(sessionId: string, model: ModelRef) {
    await this.request<boolean>(`/session/${encodeURIComponent(sessionId)}/summarize`, {
      method: 'POST',
      body: {
        providerID: model.providerID,
        modelID: model.modelID,
        auto: false,
      },
    });
  }

  revertMessage(sessionId: string, messageId: string) {
    return this.request<Session>(`/session/${encodeURIComponent(sessionId)}/revert`, {
      method: 'POST',
      body: { messageID: messageId },
    });
  }

  unrevertSession(sessionId: string) {
    return this.request<Session>(`/session/${encodeURIComponent(sessionId)}/unrevert`, {
      method: 'POST',
    });
  }

  getSessionStatus(options: WorkspaceQuery = {}, policy: RequestPolicy = {}) {
    return this.request<Record<string, SessionStatus>>(`/session/status${workspaceQuery(options)}`, {
      ...policy,
      directory: options.directory,
    });
  }

  getLspStatus(options: WorkspaceQuery = {}) {
    return this.request<LspStatus[]>(`/lsp${workspaceQuery(options)}`);
  }

  getMcpStatus(options: WorkspaceQuery = {}) {
    return this.request<McpStatusMap>(`/mcp${workspaceQuery(options)}`);
  }

  async listMessages(sessionId: string, limit = DEFAULT_MESSAGE_PAGE_LIMIT, before?: string) {
    const pages: MessageWithParts[][] = [];
    const seenCursors = new Set<string>();
    let cursor = before;
    if (cursor) seenCursors.add(cursor);

    while (true) {
      const page = await this.listMessagePage(sessionId, { limit, before: cursor });
      // The verified endpoint walks newest pages toward older pages, while the
      // messages inside each page are already oldest-to-newest. Prepending the
      // whole page preserves both contracts without ever reordering parts.
      pages.unshift(page.items);
      if (!page.nextCursor) break;
      if (seenCursors.has(page.nextCursor)) {
        throw new Error('OpenCode message pagination returned a repeated cursor');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    return pages.flat();
  }

  async listMessagePage(
    sessionId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<MessagePage> {
    const params = new URLSearchParams({ limit: String(positiveMessageLimit(options.limit)) });
    if (options.before) params.set('before', options.before);
    return this.rawFetch(
      `/session/${encodeURIComponent(sessionId)}/message?${params.toString()}`,
      {},
      async (response) => {
        const text = await response.text();
        return {
          items: text ? (JSON.parse(text) as MessageWithParts[]) : [],
          nextCursor: nextCursorFromResponse(response),
        };
      },
    );
  }

  async getSessionContext(sessionId: string) {
    const response = await this.request<{ data: SessionContextMessage[] }>(`/api/session/${encodeURIComponent(sessionId)}/context`);
    return response.data;
  }

  getSessionTodos(sessionId: string) {
    return this.request<TodoItem[]>(`/session/${encodeURIComponent(sessionId)}/todo`);
  }

  createSession(title = 'New Session', directory?: string) {
    if (!directory) throw new Error('OpenCode session creation requires a directory');
    return this.request<Session>(`/session${directory ? workspaceQuery({ directory }) : ''}`, {
      method: 'POST',
      body: { title },
      directory,
    });
  }

  sendMessage(sessionId: string, parts: MessagePart[]) {
    return this.request<MessageWithParts>(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      body: { parts },
      timeoutMs: Math.max(this.timeoutMs, 90_000),
    });
  }

  async sendAsync(sessionId: string, parts: MessagePart[], options: PromptDispatchOptions = {}) {
    assertVerifiedDispatch(options);
    await this.request<void>(
      `/session/${encodeURIComponent(sessionId)}/prompt_async${workspaceQuery({ directory: options.directory })}`,
      {
      method: 'POST',
        body: compactObject({ parts, agent: options.agent, model: options.model, variant: options.variant }),
        directory: options.directory,
      },
    );
  }

  async sendCommand(
    sessionId: string,
    command: string,
    args: string,
    options: PromptDispatchOptions = {},
  ) {
    assertVerifiedDispatch(options);
    await this.request<void>(`/session/${encodeURIComponent(sessionId)}/command${workspaceQuery({ directory: options.directory })}`, {
      method: 'POST',
      body: compactObject({
        command,
        arguments: args,
        agent: options.agent,
        model: `${options.model!.providerID}/${options.model!.modelID}`,
        variant: options.variant,
      }),
      timeoutMs: Math.max(this.timeoutMs, 90_000),
      directory: options.directory,
    });
  }

  async runShell(sessionId: string, command: string, options: Pick<PromptDispatchOptions, 'agent' | 'model' | 'directory'>) {
    await this.request<void>(`/session/${encodeURIComponent(sessionId)}/shell${workspaceQuery({ directory: options.directory })}`, {
      method: 'POST',
      body: compactObject({ command, agent: options.agent, model: options.model }),
      directory: options.directory,
    });
  }

  async abortSession(sessionId: string) {
    await this.request<void>(`/session/${encodeURIComponent(sessionId)}/abort`, {
      method: 'POST',
    });
  }

  listAgents(options: WorkspaceQuery = {}) {
    return this.request<Agent[]>(`/agent${workspaceQuery(options)}`, { directory: options.directory });
  }

  listCommands(options: WorkspaceQuery = {}) {
    return this.request<Command[]>(`/command${workspaceQuery(options)}`, { directory: options.directory });
  }

  listConfiguredProviders(options: WorkspaceQuery = {}) {
    return this.request<ConfiguredProvidersResponse>(`/config/providers${workspaceQuery(options)}`, {
      directory: options.directory,
    });
  }

  getConfig(options: WorkspaceQuery = {}) {
    return this.request<Record<string, unknown>>(`/config${workspaceQuery(options)}`, { directory: options.directory });
  }

  async findFiles(query: string, options: WorkspaceQuery = {}) {
    const paths = await this.request<string[]>(`/find/file${findFileQuery(query, options)}`);
    return paths.map((path) => ({ path }));
  }

  getSessionDiff(sessionId: string, messageId?: string) {
    const query = messageId ? `?messageID=${encodeURIComponent(messageId)}` : '';
    return this.request<FileDiff[]>(`/session/${encodeURIComponent(sessionId)}/diff${query}`);
  }

  listPermissions(options: WorkspaceQuery = {}) {
    return this.request<PermissionRequest[]>(`/permission${workspaceQuery(options)}`, { directory: options.directory });
  }

  async respondToPermission(_sessionId: string, permissionId: string, reply: PermissionReply, options: WorkspaceQuery = {}) {
    await this.request<void>(
      `/permission/${encodeURIComponent(permissionId)}/reply${workspaceQuery(options)}`,
      {
        method: 'POST',
        body: reply,
        directory: options.directory,
      },
    );
  }

  listQuestions(options: WorkspaceQuery = {}) {
    return this.request<QuestionRequest[]>(`/question${workspaceQuery(options)}`, { directory: options.directory });
  }

  async respondToQuestion(requestId: string, reply: QuestionReplyBody, options: WorkspaceQuery = {}) {
    await this.request<void>(`/question/${encodeURIComponent(requestId)}/reply${workspaceQuery(options)}`, {
      method: 'POST',
      body: reply,
      directory: options.directory,
    });
  }

  async rejectQuestion(requestId: string, options: WorkspaceQuery = {}) {
    await this.request<void>(`/question/${encodeURIComponent(requestId)}/reject${workspaceQuery(options)}`, {
      method: 'POST',
      directory: options.directory,
    });
  }

  subscribeEvents(onEvent: (event: ServerEvent) => void, options: EventSubscriptionOptions = {}): () => void {
    let stopped = false;
    let activeController: AbortController | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveReconnectDelay: (() => void) | undefined;
    const firstByteTimeoutMs = options.firstByteTimeoutMs ?? 20_000;
    const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 15_000;
    const idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
    const random = options.random ?? Math.random;

    const run = async () => {
      let reconnecting = false;
      let reconnectAttempt = 0;
      options.onConnectionState?.('connecting');
      while (!stopped) {
        const isReconnectAttempt = reconnecting;
        if (reconnecting) {
          options.onConnectionState?.('reconciling');
          const exponentialDelay = Math.min(reconnectMaxDelayMs, reconnectDelayMs * 2 ** Math.min(reconnectAttempt, 6));
          const jitteredDelay = Math.max(0, Math.round(exponentialDelay * (0.8 + random() * 0.4)));
          await new Promise<void>((resolve) => {
            resolveReconnectDelay = resolve;
            reconnectTimer = setTimeout(() => {
              resolveReconnectDelay = undefined;
              resolve();
            }, jitteredDelay);
          });
          if (stopped) break;
        }
        reconnecting = true;
        reconnectAttempt += 1;
        const controller = new AbortController();
        activeController = controller;
        const firstByteTimer = setTimeout(() => controller.abort(), firstByteTimeoutMs);
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const armIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
        };
        let reconnectNotified = false;
        const parser = createSseParser((event) => {
          onEvent(event);
          if (!reconnectNotified && event.type === 'server.connected') {
            reconnectNotified = true;
            reconnectAttempt = 0;
            if (isReconnectAttempt) {
              void Promise.resolve(options.onReconnect?.()).finally(() => {
                if (!stopped) options.onConnectionState?.('live');
              });
            } else {
              options.onConnectionState?.('live');
            }
          }
        });
        try {
          const response = await this.rawFetch(
            `/event${options.directory ? workspaceQuery({ directory: options.directory }) : ''}`,
            { signal: controller.signal, directory: options.directory },
            async (response) => response,
          );
          const body = response.body;
          const reader = body && 'getReader' in body ? body.getReader() : undefined;
          if (!reader) throw new Error('OpenCode event stream has no readable body');
          const decoder = new TextDecoder();
          let receivedByte = false;
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!receivedByte) {
              receivedByte = true;
              clearTimeout(firstByteTimer);
            }
            armIdleTimer();
            parser.push(decoder.decode(value, { stream: true }));
          }
          parser.flush();
        } catch (error) {
          if (stopped) break;
          if (error instanceof OpenCodeRequestError && !error.transient) {
            options.onConnectionState?.('offline', error);
            return;
          }
          options.onConnectionState?.('reconciling', error);
        } finally {
          clearTimeout(firstByteTimer);
          if (idleTimer) clearTimeout(idleTimer);
          if (activeController === controller) activeController = undefined;
        }
      }
      if (!stopped) options.onConnectionState?.('offline');
    };

    void run();
    return () => {
      stopped = true;
      activeController?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resolveReconnectDelay?.();
      resolveReconnectDelay = undefined;
      options.onConnectionState?.('offline');
    };
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      timeoutMs?: number;
      directory?: string;
      retry?: boolean;
    } = {},
  ): Promise<T> {
    return this.rawFetch(path, {
      method: options.method ?? 'GET',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      timeoutMs: options.timeoutMs,
      directory: options.directory,
      retry: options.retry,
    }, async (response) => {
      const text = await response.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    });
  }

  private async rawFetch<T>(
    path: string,
    options: {
      method?: string;
      body?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      directory?: string;
      retry?: boolean;
    },
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    this.assertTransportAllowed();
    const method = options.method ?? 'GET';
    const maxAttempts = !options.signal && method === 'GET' && options.retry !== false ? 3 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = options.signal ? undefined : new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timeoutError: OpenCodeRequestError | undefined;
      const deadline = controller ? new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timeoutError = new OpenCodeRequestError(
            `OpenCode request timed out after ${Math.ceil((options.timeoutMs ?? this.timeoutMs) / 1000)}s (${method} ${path.split('?')[0]})`,
            undefined,
            true,
          );
          // Bound both headers and body, even if a native body read fails to
          // settle when its task is canceled. The request is still aborted.
          reject(timeoutError);
          controller.abort();
        }, options.timeoutMs ?? this.timeoutMs);
      }) : undefined;
      try {
        const perform = async () => {
          const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method,
            headers: {
              ...buildAuthHeaders(this.connection),
              ...(this.relayTargetID ? { 'X-OpenCode-Target': this.relayTargetID } : {}),
              ...(options.directory ? { 'X-OpenCode-Directory': options.directory } : {}),
            },
            body: options.body,
            signal: options.signal ?? controller?.signal,
          });
          if (!response.ok) {
            const rawDetail = await response.text().catch(() => '');
            const detail = formatResponseErrorDetail(
              rawDetail,
              response.headers?.get?.('content-type') ?? '',
              response.statusText,
            );
            const transient = response.status === 408 || response.status === 429 || response.status >= 500;
            throw new OpenCodeRequestError(
              `OpenCode request failed (${response.status})${detail ? `: ${detail}` : ''}`,
              response.status,
              transient,
            );
          }
          return consume(response);
        };
        return await (deadline ? Promise.race([perform(), deadline]) : perform());
      } catch (error) {
        const failure = timeoutError ?? error;
        if (timeout) clearTimeout(timeout);
        lastError = failure;
        if (attempt + 1 >= maxAttempts || !isTransientOpenCodeError(failure)) throw failure;
        await delay(250 * 2 ** attempt);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  private assertTransportAllowed() {
    if (!this.release) return;
    const url = new URL(this.baseUrl);
    if (url.protocol === 'https:') return;
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return;
    throw new Error('HTTPS is required for OpenCode Mobile release connections');
  }
}

function formatResponseErrorDetail(rawDetail: string, contentType: string, statusText?: string) {
  const trimmed = rawDetail.trim();
  if (!trimmed) return statusText?.trim() ?? '';
  if (contentType.includes('text/html') || /<!doctype\s+html|<html[\s>]/i.test(trimmed)) {
    return statusText?.trim() || 'Relay gateway returned an HTML error page';
  }
  if (contentType.includes('application/json') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ['message', 'error', 'detail']) {
        if (typeof parsed[key] === 'string' && parsed[key]) return parsed[key];
      }
    } catch {
      // Fall through to a bounded plain-text detail.
    }
  }
  return trimmed.length > 320 ? `${trimmed.slice(0, 317)}…` : trimmed;
}

interface ApiSessionPage {
  data?: Session[];
  cursor?: {
    previous?: string;
    next?: string;
  };
}

function normalizeEnumeratedSession(session: Session, relayTargetID?: string): Session {
  const directory = session.location?.directory ?? session.directory ?? session.path;
  return {
    ...session,
    ...(directory ? { directory } : {}),
    ...(relayTargetID ? { relayTargetID } : {}),
  };
}

export function compareSessionsByRecency(a: Session, b: Session) {
  const updated = sessionTimestamp(b, 'updated') - sessionTimestamp(a, 'updated');
  if (updated !== 0) return updated;
  const created = sessionTimestamp(b, 'created') - sessionTimestamp(a, 'created');
  if (created !== 0) return created;
  const target = (a.relayTargetID ?? '').localeCompare(b.relayTargetID ?? '');
  return target !== 0 ? target : a.id.localeCompare(b.id);
}

function sessionTimestamp(session: Session, field: 'created' | 'updated') {
  const numeric = session.time?.[field];
  if (typeof numeric === 'number' && Number.isFinite(numeric)) return numeric;
  const legacy = session[field];
  if (!legacy) return 0;
  const parsed = Date.parse(legacy);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveMessageLimit(limit = DEFAULT_MESSAGE_PAGE_LIMIT) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('OpenCode message limit must be a positive integer');
  }
  return limit;
}

function nextCursorFromResponse(response: Response) {
  const direct = response.headers?.get?.('X-Next-Cursor');
  if (direct) return direct;
  const link = response.headers?.get?.('Link');
  if (!link) return null;
  const next = link.split(',').find((value) => /rel="?next"?/i.test(value));
  const href = next?.match(/<([^>]+)>/)?.[1];
  if (!href) return null;
  try {
    return new URL(href).searchParams.get('before');
  } catch {
    return null;
  }
}

function assertVerifiedDispatch(options: PromptDispatchOptions) {
  if (!options.agent || !options.model?.providerID || !options.model.modelID || !options.directory) {
    throw new Error('OpenCode dispatch requires agent, model, and directory');
  }
}

function isAbortError(error: unknown) {
  return (
    typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError'
  ) || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError');
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
