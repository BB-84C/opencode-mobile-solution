export type AuthType = 'bearer' | 'basic';

export interface HostConnection {
  id: string;
  name: string;
  url: string;
  authType: AuthType;
  token?: string;
  username?: string;
  password?: string;
  relayDeviceID?: string;
  relayNameRevision?: number;
  relayNameUpdatedAt?: string;
  lastConnected: string | null;
  isReachable: boolean;
}

export interface RelayDeviceIdentity {
  clientID: string;
  displayName: string;
  displayNameRevision?: number;
  displayNameUpdatedAt?: string;
}

export interface HealthResponse {
  healthy: boolean;
  version: string;
}

export interface Project {
  name: string;
  directory: string;
  vcs?: string;
}

export interface ProjectGroup {
  id?: string;
  name: string;
  directory: string;
  sessionCount: number;
  relayTargetID?: string;
  relayTargetName?: string;
}

export interface RelayTarget {
  id: string;
  name: string;
}

export interface RelayTargetState extends RelayTarget {
  reachable: boolean;
  lastChecked: string | null;
  error?: string;
}

export interface FileReference {
  path: string;
}

export interface Session {
  id: string;
  title?: string;
  agent?: string;
  model?: ModelRef & { variant?: string };
  directory?: string;
  path?: string;
  location?: {
    directory?: string;
  };
  relayTargetID?: string;
  relayTargetName?: string;
  share?: {
    url?: string;
  } | null;
  shareUrl?: string;
  shareURL?: string;
  workspaceID?: string | null;
  parentID?: string;
  revert?: {
    messageID?: string;
    diff?: string;
  };
  created?: string;
  updated?: string;
  time?: {
    created?: number;
    updated?: number;
  };
}

export type SessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; message?: string; attempt?: number; next?: number }
  | { running: boolean; agent?: string; model?: string };

export interface Agent {
  name: string;
  model?: string | ModelRef | Record<string, unknown>;
  variant?: string;
  description?: string;
  native?: boolean;
  mode?: string;
  hidden?: boolean;
}

export interface Command {
  name: string;
  description?: string;
  source?: string;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface ProviderModel {
  id: string;
  providerID: string;
  name?: string;
  family?: string;
  status?: string;
  release_date?: string | number;
  variants?: Record<string, unknown>;
  capabilities?: {
    reasoning?: boolean;
    attachment?: boolean;
    toolcall?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ConfiguredProvider {
  id: string;
  name?: string;
  models: Record<string, ProviderModel>;
  [key: string]: unknown;
}

export interface ConfiguredProvidersResponse {
  providers: ConfiguredProvider[];
  default: Record<string, string>;
}

export interface PromptSelection {
  agentName?: string;
  model?: ModelRef;
  variant?: string;
}

export interface MachineExecutionContract {
  connectionId: string;
  relayTargetID?: string;
  relayTargetName?: string;
  directory?: string;
  agents: Agent[];
  providers: ConfiguredProvider[];
  providerDefaults: Record<string, string>;
  configModel?: string;
  commands: Command[];
  fetchedAt: string;
}

export type MachineExecutionContractLoadStatus =
  | 'unverified'
  | 'loading'
  | 'fresh'
  | 'stale'
  | 'error';

/**
 * Verification state for one machine + directory execution contract.
 * A cached contract may remain available for display while `status` is
 * `stale`, but prompt dispatch is permitted only while it is `fresh`.
 */
export interface MachineExecutionContractLoadState {
  status: MachineExecutionContractLoadStatus;
  attemptedAt: string;
  verifiedAt?: string;
  error: string | null;
}

/** `idle` is an intentional absence of a live subscription, not an outage. */
export type SessionTransportState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconciling'
  | 'offline';

export interface PromptDispatchOptions {
  agent?: string;
  model?: ModelRef;
  variant?: string;
  directory?: string;
}

export interface QueuedPrompt {
  id: string;
  connectionId: string;
  sessionId: string | null;
  text: string;
  promptMode: 'ask' | 'shell';
  agent?: string;
  model?: ModelRef;
  variant?: string;
  directory?: string;
  relayTargetID?: string;
  createdAt: string;
}

export interface MessagePage {
  items: MessageWithParts[];
  nextCursor: string | null;
}

export interface TextPart {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

export interface FilePart {
  type: 'file';
  mime?: string;
  filename?: string;
  url?: string;
  [key: string]: unknown;
}

export interface ToolPart {
  type: 'tool' | 'tool_use' | 'tool_result';
  tool?: string;
  callID?: string;
  state?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ReasoningPart {
  type: 'reasoning';
  text?: string;
  [key: string]: unknown;
}

export type MessagePart = TextPart | FilePart | ToolPart | ReasoningPart | ({ type: string } & Record<string, unknown>);

export interface MessageInfo {
  id: string;
  sessionID?: string;
  role: 'user' | 'assistant';
  agent?: string;
  model?: string | (ModelRef & { variant?: string }) | Record<string, unknown>;
  providerID?: string;
  variant?: string;
  created?: string;
  time?: {
    created?: number;
    completed?: number;
  };
}

export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

export type SessionContextMessage = Record<string, unknown>;

export type LspStatus = Record<string, unknown>;
export type McpStatusMap = Record<string, { status?: string; [key: string]: unknown }>;

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | string;
  priority: 'high' | 'medium' | 'low' | string;
}

export interface PermissionReply {
  response?: boolean;
  remember?: boolean;
  reply?: 'once' | 'always' | 'reject';
  message?: string;
}

export interface QuestionReplyBody {
  answers: string[][];
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  header: string;
  question: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: {
    messageID: string;
    callID: string;
  };
}
