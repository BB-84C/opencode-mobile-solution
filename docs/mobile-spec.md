# OpenCode Mobile — App Specification
> Target: iOS + Android (cross-platform)  
> Delegate to: Codex (OpenAI Codex native iOS app development)  
> Reference UX: ChatGPT mobile app's Codex integration

> UX alignment override: follow `docs/opencode-mobile-tui-ux-spec.md` for the approved OpenCode TUI interaction model. That file is the source of truth whenever this older product spec describes a project-list-first or generic-chat UX.

## Normative Reading Order

For implementation and review, use these sources in order:

1. `docs/opencode-mobile-tui-ux-spec.md` for interaction and visual behavior.
2. Section 13 of this file for the verified transport contract.
3. `docs/codex-e2e-connection.md` for the live endpoint and operational test rules.
4. `docs/opencode-mobile-e2e-coverage.md` for evidence status and remaining gaps.

Sections 0-12 preserve the original product rationale and early wireframes. They are
**non-normative historical context** where they conflict with the sources above. In
particular, project-list-first navigation, generic chat bubbles, optional prompt dispatch
metadata, two-button permissions, and character-by-character rendering are superseded.

The implemented stack is Expo 57 / React Native 0.86 / Expo Router / Zustand, using
React Native `StyleSheet`, `expo-secure-store`, AsyncStorage, and fetch-based SSE parsing.
NativeWind, Tamagui, MMKV, and EventSource are not current implementation dependencies.

---

## 0. Product Vision

A mobile companion app for OpenCode that turns your phone into a remote control panel for agent coding sessions running on your desktop. Not an IDE — a cockpit. Start threads, approve actions, review diffs, watch test output, switch between hosts. All from your pocket.

**Core insight**: The phone is a supervision surface, not a development machine. Zero code editing on the phone. The desktop/VM runs the agent; the phone observes and approves.

---

## 1. Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | **Expo (React Native)** with Expo Router | TypeScript, file-based routing, fast dev cycle, EAS Build for cloud iOS/Android builds |
| UI Components | NativeWind (TailwindCSS for RN) or tamagui | Design system consistency |
| HTTP Client | Custom fetch wrapper over OpenCode REST API | No SDK needed — API is a clean REST surface |
| Real-time | SSE (EventSource polyfill for RN) | OpenCode server exposes `/event` as SSE |
| State | Zustand or Jotai | Lightweight, hook-based |
| Persistence | AsyncStorage + MMKV | Session cache, auth tokens |
| Navigation | Expo Router (file-based) | Tab bar + stack navigation |

**Why Expo over Flutter**: TypeScript is the same language as the OpenCode ecosystem. The Codex agent has native Expo/Swift knowledge. Expo's EAS Build eliminates the need for local Xcode/Android Studio.

**Why Expo over SwiftUI + Kotlin native**: Two codebases = 2x maintenance. For a control panel app (not a game), React Native performance is more than adequate.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Mobile App (Expo)                      │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Hosts   │  │ Projects │  │ Sessions │  │ Chat     │ │
│  │ Screen  │  │ Screen   │  │ List     │  │ Screen   │ │
│  └─────────┘  └──────────┘  └──────────┘  └──────────┘ │
│       │             │              │              │       │
│  ┌────┴─────────────┴──────────────┴──────────────┴───┐ │
│  │                  API Layer                          │ │
│  │  OpenCodeClient (fetch + SSE + auth + retry)       │ │
│  └──────────────────────┬─────────────────────────────┘ │
└─────────────────────────┼───────────────────────────────┘
                          │ HTTPS
                          ▼
┌──────────────────────────────────────────────────────────┐
│              User's VPS / Relay                          │
│  Caddy → Token Relay (4097) → frp Tunnel → Local OC     │
│  (or: Caddy → frp Tunnel → Local OC with Basic Auth)     │
└──────────────────────────────────────────────────────────┘
```

### Connection Model

Users configure one or more **host connections**:

```typescript
interface HostConnection {
  id: string;           // UUID
  name: string;         // "example VPS", "Work DevBox"
  url: string;          // "https://opencode.example.com" or "https://1.2.3.4:4096"
  authType: 'bearer' | 'basic';
  token?: string;       // Bearer token (stored in secure storage)
  username?: string;    // Basic auth username
  password?: string;    // Basic auth password (stored in secure storage)
  lastConnected: Date;
  isReachable: boolean;
}
```

**The app must NOT hardcode opencode.example.com.** The default onboarding tells the user to open their own relay Dashboard, authenticate with a passkey, press **Connect phone**, and scan its QR code. Manual URL + Bearer/Basic configuration remains available under an advanced recovery disclosure.

---

## 3. Screen Designs

### 3.1 Hosts Screen (Root Tab)

```
┌─────────────────────────────────────┐
│  OpenCode                    [⚙️]  │  ← Settings gear
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 🟢 example Home PC             │    │
│  │    opencode.example.com         │    │
│  │    3 active sessions        │    │
│  │    D:\workspace               │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 🔴 Work DevBox              │    │
│  │    192.168.1.100:4096       │    │
│  │    Unreachable              │    │
│  └─────────────────────────────┘    │
│                                     │
│  [+] Add Host                       │
│                                     │
└─────────────────────────────────────┘
```

**Host states**: 🟢 Connected / 🟡 Connecting / 🔴 Unreachable / ⚪ Idle (not checked)

### 3.2 Projects Screen (per Host)

When a host is tapped → navigate to its projects:

```
┌─────────────────────────────────────┐
│  ← example Home PC                     │
├─────────────────────────────────────┤
│  🔍 Search projects...              │
│                                     │
│  📁 example.ai                   3 💬  │
│     D:\workspace                      │
│  📁 Fallout-Wastland-Sim      1 💬  │
│     D:\Fallout-Wastland-Simulation  │
│  📁 opencode_cost_observatory 2 💬  │
│     D:\workspace\tools\opencode...    │
│  📁 opencode-vps                  1 💬  │
│     D:\workspace\tools\opencode-vps      │
│                                     │
│  [+] New Session                    │  ← Creates session tied to a project
└─────────────────────────────────────┘
```

**Data source**: `GET /session` grouped by `directory` field. `GET /project` for project metadata.

### 3.3 Sessions Screen (per Project)

Tap a project → see its sessions:

```
┌─────────────────────────────────────┐
│  ← example.ai                          │
├─────────────────────────────────────┤
│  ┌─────────────────────────────┐    │
│  │ 🟢 fix the Discord bridge   │    │  ← Green dot = agent running
│  │    orc-DeepSeek · 3m ago    │    │
│  └─────────────────────────────┘    │
│  ┌─────────────────────────────┐    │
│  │ ⚪ refactor uploader         │    │
│  │    orc-Claude · 2h ago      │    │
│  └─────────────────────────────┘    │
│  ┌─────────────────────────────┐    │
│  │ ✅ CRS archive investigation │    │
│  │    orc-GPT · yesterday      │    │
│  └─────────────────────────────┘    │
│                                     │
│  [+] New Session                    │
└─────────────────────────────────────┘
```

**Session metadata**: Title, agent/model, last activity time, running/idle/completed status.

**Data source**: `GET /session` filtered by directory. `GET /session/status` for running/idle state.

### 3.4 Chat Screen (Core Experience)

Tap a session → full chat view:

```
┌─────────────────────────────────────┐
│  ← CRS archive investigation   [⋯] │  ← Back + overflow menu
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────────┐    │
│  │ [You]                        │    │
│  │ Check the S3 backup status   │    │
│  │ for the CRS request archive. │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ [Agent · orc-DeepSeek]       │    │
│  │ Running: aws s3 ls           │    │
│  │ s3://opencode-vps-backup/...     │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ [Tool Output]                │    │
│  │ 2026-07-08/observatory...    │    │
│  │ 2026-07-09/observatory...    │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ [Agent]                      │    │
│  │ The backup is healthy.       │    │
│  │ 3 files found. 27MB total.   │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ [Diff: archive.ts]     📋   │    │  ← Copy button
│  │ ┌───────────────────────┐   │    │
│  │ │ +15 -3 in archive.ts  │   │    │
│  │ │ +  const backupDir    │   │    │
│  │ │ +    = path.join(...) │   │    │
│  │ │ -  const tmpDir       │   │    │
│  │ └───────────────────────┘   │    │
│  │ [View Full Diff]            │    │  ← Expands to full file diff viewer
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────────┐│
│  │ [⚠️ Approval Required]         ││
│  │ Run: npm run deploy             ││
│  │                                 ││
│  │ [Approve]  [Reject]  [Details]  ││
│  └─────────────────────────────────┘│
│                                     │
├─────────────────────────────────────┤
│  ⌨️ Type a message...        [↑]   │  ← Keyboard area
└─────────────────────────────────────┘
```

**Message types**:
- `user` — User prompt (right-aligned or tinted)
- `assistant` — Agent response (left-aligned)
- `tool_use` — Tool invocation (collapsed by default, expandable)
- `tool_result` — Tool output (collapsed by default, expandable)
- `diff` — Code changes (syntax-highlighted, expandable)
- `approval` — Permission request (interactive: approve/reject buttons)
- `error` — Error messages (red-tinted, collapsible)
- `thinking` — Agent reasoning (collapsed behind "Show thinking" toggle)

**Transcript ordering and scrolling**: Message pagination follows every server `nextCursor`
until exhaustion, then normalizes the result by server-authoritative message creation time
because the API walks pages newest-to-older while each page is internally
oldest-to-newest. A repeated cursor is a protocol error, not an invitation to loop. Parts
inside one message retain their server array order; part timestamps are incomplete and are
not a sortable sequence contract. The complete transcript remains available to state,
copy, and export operations, while the native list initially receives only the latest 100
messages and reveals older history in bounded 100-message windows. The virtualized
transcript is inverted so the final part of the newest message is native offset zero,
including when that message is taller than the viewport.
Opening a session therefore starts at the true latest part without an approximate
`scrollToEnd` retry. New content follows only while the reader remains at the latest edge.
When the reader scrolls away, a one-tap "Latest" FAB issues one non-animated offset-zero
jump and remains visible until native metrics confirm the return; timers, animated
distance-dependent chasing, and retry loops are forbidden.

### 3.5 Diff Viewer (Full Screen)

Tap "View Full Diff" → dedicated diff screen:

```
┌─────────────────────────────────────┐
│  ← archive.ts                       │
├─────────────────────────────────────┤
│  12  const backupDir = path.join(   │
│  13    config.dataDir,              │
│  14    'backups'                    │
│  15  )                              │
│     ─────────────────────────────   │
│  +16  const archiveDir = path.join( │  ← Green = added
│  +17    backupDir,                  │
│  +18    'archive'                   │
│  +19  )                             │
│     ─────────────────────────────   │
│  -20  const tmpDir = path.join(     │  ← Red = removed
│  -21    backupDir,                  │
│  -22    '.tmp'                      │
│  -23  )                             │
│  24                                 │
│  25  async function runBackup() {   │
└─────────────────────────────────────┘
```

**Features**: Syntax highlighting (language detected from file extension), line numbers, swipe between files in multi-file diff, copy full diff to clipboard.

### 3.6 New Session / Prompt Screen

Tap "+" → quick prompt or session creation:

```
┌─────────────────────────────────────┐
│  ← New Session              [Send]  │
├─────────────────────────────────────┤
│                                     │
│  Project: example.ai            [▼]   │  ← Picker for project directory
│  Agent:   orchestrator        [▼]   │  ← Optional: pick agent
│  Model:   orc-DeepSeek        [▼]   │  ← Optional: pick model
│                                     │
│  ┌─────────────────────────────┐    │
│  │                             │    │
│  │  What should the agent do?  │    │
│  │                             │    │
│  └─────────────────────────────┘    │
│                                     │
│  [📎 Attach File]  [📷 Screenshot]  │
│                                     │
└─────────────────────────────────────┘
```

**Session creation**: `POST /session { title: auto-generated }` → `POST /session/:id/message { parts: [...] }`.

### 3.7 Settings Screen

```
┌─────────────────────────────────────┐
│  ← Settings                         │
├─────────────────────────────────────┤
│                                     │
│  HOSTS                              │
│  ┌─────────────────────────────┐    │
│  │ example Home PC            [>] │    │
│  └─────────────────────────────┘    │
│  [+] Add Host                       │
│                                     │
│  APPEARANCE                         │
│  Theme:  [System ▼]                 │
│  Font:   [Monospace code blocks]    │
│                                     │
│  DATA                               │
│  Clear session cache                │
│  Export logs                        │
│                                     │
│  ABOUT                              │
│  Version 1.0.0                      │
│  OpenCode Mobile                    │
│                                     │
└─────────────────────────────────────┘
```

---

## 4. API Integration

### 4.1 OpenCodeClient Class

```typescript
class OpenCodeClient {
  constructor(connection: HostConnection) { ... }

  // Health
  async health(): Promise<{ healthy: boolean; version: string }>

  // Projects
  async listProjects(): Promise<Project[]>
  async getCurrentProject(): Promise<Project>

  // Sessions
  async listSessions(): Promise<Session[]>
  async getSession(id: string): Promise<Session>
  async createSession(title?: string): Promise<Session>
  async deleteSession(id: string): Promise<void>
  async forkSession(id: string, messageId?: string): Promise<Session>
  async getSessionStatus(): Promise<Record<string, SessionStatus>>

  // Messages
  async listMessages(sessionId: string, limit?: number): Promise<MessageWithParts[]>
  async listMessagePage(sessionId: string, options?: { limit?: number; before?: string }): Promise<{ items: MessageWithParts[]; nextCursor: string | null }>
  async getMessage(sessionId: string, messageId: string): Promise<MessageWithParts>
  async sendMessage(sessionId: string, parts: Part[], options?: SendOptions): Promise<MessageWithParts>
  async sendAsync(sessionId: string, parts: Part[], options?: SendOptions): Promise<void>
  async abortSession(sessionId: string): Promise<void>

  // Real-time
  subscribeEvents(onEvent: (event: ServerEvent) => void): () => void  // Returns unsubscribe

  // Files & Diffs
  async getFileContent(path: string): Promise<FileContent>
  async getSessionDiff(sessionId: string, messageId?: string): Promise<FileDiff[]>

  // Permissions
  async respondToPermission(sessionId: string, permissionId: string, response: boolean): Promise<void>

  // Commands
  async listAgents(): Promise<Agent[]>
  async listCommands(): Promise<Command[]>
}
```

### 4.2 Auth Header Construction

```typescript
function buildHeaders(connection: HostConnection): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (connection.authType === 'bearer') {
    headers['Authorization'] = `Bearer ${connection.token}`;
  } else if (connection.authType === 'basic') {
    const encoded = btoa(`${connection.username}:${connection.password}`);
    headers['Authorization'] = `Basic ${encoded}`;
  }

  return headers;
}
```

### 4.3 SSE Event Stream

```typescript
function subscribeToEvents(
  connection: HostConnection,
  onEvent: (event: any) => void
): () => void {
  const url = `${connection.url}/event`;
  const headers = buildHeaders(connection);

  // Use EventSource or fetch with streaming for React Native
  const controller = new AbortController();

  fetch(url, {
    headers,
    signal: controller.signal,
  }).then(async (response) => {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE format: "event: name\ndata: {...}\n\n"
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        const lines = event.split('\n');
        let eventName = '';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventName = line.slice(7);
          if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (data) {
          try { onEvent({ type: eventName, ...JSON.parse(data) }); } catch {}
        }
      }
    }
  });

  return () => controller.abort();
}
```

### 4.4 Key API Endpoints Reference

See OpenCode Server docs: `https://opencode.ai/docs/server/`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/global/health` | GET | Health check |
| `/project` | GET | List all projects |
| `/session` | GET/POST | List/Create sessions |
| `/session/:id` | GET/DELETE/PATCH | Get/Delete/Update session |
| `/session/:id/message` | GET/POST | List/Send messages |
| `/session/:id/message/:mid` | GET | Get specific message |
| `/session/:id/prompt_async` | POST | Send async (fire & forget) |
| `/session/:id/abort` | POST | Abort running session |
| `/session/:id/fork` | POST | Fork session |
| `/session/:id/diff` | GET | Get session diff |
| `/session/:id/permissions/:pid` | POST | Respond to permission request |
| `/session/status` | GET | Status for all sessions |
| `/event` | GET | SSE event stream |
| `/file/content` | GET | Read file content |
| `/agent` | GET | List available agents |

---

## 5. Data Models

```typescript
// ── Connection ──
interface HostConnection {
  id: string;
  name: string;
  url: string;            // "https://opencode.example.com"
  authType: 'bearer' | 'basic';
  token?: string;
  username?: string;
  password?: string;
}

// ── Project ──
interface Project {
  name: string;
  directory: string;      // "D:\\workspace"
  vcs?: string;           // "git"
}

// ── Session ──
interface Session {
  id: string;
  title?: string;
  directory?: string;     // Project directory (for grouping)
  parentID?: string;
  created: string;        // ISO datetime
  updated: string;
}

// ── Session Status ──
interface SessionStatus {
  running: boolean;
  agent?: string;
  model?: string;
}

// ── Message ──
interface Message {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  agent?: string;
  model?: string;
  created: string;
}

interface MessagePart {
  id: string;
  messageID: string;
  type: 'text' | 'tool_use' | 'tool_result' | 'reasoning' | 'file';
  // ... type-specific fields
}

interface TextPart extends MessagePart {
  type: 'text';
  text: string;
}

interface ToolUsePart extends MessagePart {
  type: 'tool_use';
  tool: string;
  input: Record<string, any>;
}

interface ToolResultPart extends MessagePart {
  type: 'tool_result';
  tool: string;
  output: string;
  isError: boolean;
}

// ── Diff ──
interface FileDiff {
  path: string;
  hunks: DiffHunk[];
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

// ── Permission Request ──
interface PermissionRequest {
  id: string;
  sessionID: string;
  type: string;           // e.g., "shell", "file_write", "mcp_tool"
  detail: string;         // Human-readable description
  command?: string;       // For shell permissions
}
```

---

## 6. State Management (Zustand)

```typescript
interface AppState {
  // Connections
  connections: HostConnection[];
  activeConnectionId: string | null;
  addConnection: (conn: HostConnection) => void;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string) => void;

  // Projects (per connection)
  projects: Record<string, Project[]>;  // connectionId → Project[]
  loadProjects: (connectionId: string) => Promise<void>;

  // Sessions (per connection)
  sessions: Record<string, Session[]>;  // connectionId → Session[]
  sessionStatuses: Record<string, Record<string, SessionStatus>>;
  loadSessions: (connectionId: string) => Promise<void>;

  // Active chat
  activeSessionId: string | null;
  messages: Record<string, MessageWithParts[]>;  // sessionId → messages
  loadMessages: (sessionId: string) => Promise<void>;
  sendMessage: (sessionId: string, text: string) => Promise<void>;
  abortSession: (sessionId: string) => Promise<void>;

  // Real-time
  eventUnsubscribers: Record<string, () => void>;
  subscribeToHost: (connectionId: string) => void;
  unsubscribeFromHost: (connectionId: string) => void;
}
```

---

## 7. Navigation Structure (Expo Router)

```
app/
├── (tabs)/
│   ├── _layout.tsx          ← Tab bar: Hosts | (active project) | Settings
│   ├── hosts.tsx            ← Hosts list
│   └── settings.tsx         ← Settings
├── host/
│   └── [hostId]/
│       ├── projects.tsx     ← Projects for this host
│       └── project/
│           └── [projectDir]/
│               ├── sessions.tsx   ← Sessions for this project
│               └── [sessionId]/
│                   ├── chat.tsx   ← Chat view (main)
│                   └── diff.tsx   ← Full diff viewer
├── add-host.tsx             ← Add/edit host connection
└── new-session.tsx          ← Create new session
```

URL scheme (deep linking, future): `opencode://host/:id/project/:dir/session/:sid`

---

## 8. UX Details (Match ChatGPT+Codex Feel)

### 8.1 Loading States
- Skeleton screens for message lists (not spinners)
- Pull-to-refresh on session list
- "Agent is thinking..." animated dots during generation

### 8.2 Error States
- Connection lost → banner at top with "Reconnecting..." and retry button
- API error → inline error message, not modal
- Token expired → redirect to host settings

### 8.3 Real-time Updates
- New messages stream in character-by-character (SSE → incremental UI updates)
- Tool calls appear as collapsible cards, open automatically during streaming
- Diff cards appear when agent modifies files
- Permission requests push a full-width interactive card

### 8.4 Approval Flow
- When agent needs permission, a prominent card appears with:
  - Command/file to be modified
  - Approve / Reject buttons
  - "Remember for session" toggle
- Approval responses: `POST /session/:id/permissions/:pid { response: true/false, remember?: true }`

### 8.5 Session Actions (Overflow Menu)
- Fork session
- Share session
- Delete session
- Copy session ID
- Change model mid-session

### 8.6 Offline Behavior
- Cache last-viewed sessions and messages locally
- Show cached data when offline with "Offline" badge
- Queue outgoing messages for send when reconnected
- Clear visual indicator when connection restored

---

## 9. Security Requirements

1. **Tokens in Secure Storage**: Use `expo-secure-store` (Keychain on iOS, EncryptedSharedPreferences on Android) for auth tokens and passwords. Never in AsyncStorage.
2. **HTTPS Only**: Reject plain HTTP connections in release builds. Show warning for self-signed certs (allow with explicit user approval).
3. **No Token in Logs**: Strip `Authorization` headers from all logging.
4. **Certificate Pinning** (future): Pin Cloudflare/known certs for opencode.example.com.
5. **Auto-lock**: Optional biometric lock (Face ID / fingerprint) to open the app.

---

## 10. Build & Distribution

### Development
```bash
npx create-expo-app@latest opencode-mobile --template tabs
cd opencode-mobile
npx expo install expo-secure-store expo-router @react-native-async-storage/async-storage
```

### Testing
- Expo Go on physical iOS/Android devices for dev testing
- Connect to a real OpenCode server (local or VPS)

### Production Build
- EAS Build for cloud iOS/Android builds
- iOS: TestFlight → App Store
- Android: EAS Build → Google Play or direct APK

### Environment Config
```typescript
// app.config.ts
export default {
  expo: {
    name: 'OpenCode Mobile',
    slug: 'opencode-mobile',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    scheme: 'opencode',
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.example.opencodemobile',
    },
    android: {
      adaptiveIcon: { ... },
      package: 'com.example.opencodemobile',
    },
  },
};
```

---

## 11. Development Phases (for Codex)

### Phase 1: Scaffold + Connect
- Expo project with file-based routing
- Host connection screen (add/edit/delete)
- OpenCodeClient class with health check
- Test against real server

### Phase 2: Browse  
- Projects list (grouped by directory)
- Sessions list per project
- Session status indicators

### Phase 3: Chat
- Message list with type-aware rendering
- Send message (synchronous)
- Loading/streaming states
- Basic diff card

### Phase 4: Real-time
- SSE event stream connection
- Live message streaming
- Auto-scroll behavior
- Reconnection logic

### Phase 5: Advanced
- Approval flow (permission cards)
- Full diff viewer
- Fork session
- Model/agent switching
- Dark mode

### Phase 6: Polish
- Offline cache
- Biometric lock
- Push notifications (future: webhook from VPS)
- Deep linking
- App Store screenshots + metadata

---

## 12. Acceptance Criteria

- [ ] User can add a host by URL (domain or IP)
- [ ] User can authenticate via bearer token or basic auth
- [ ] User can pair from a relay Dashboard QR without typing a URL or credential
- [ ] A paired credential survives app/relay restarts until explicitly revoked
- [ ] The passkey Dashboard lists paired devices and can revoke one immediately
- [ ] App shows all projects grouped by directory
- [ ] App shows all sessions per project with running/idle status
- [ ] User can view full message history for any session
- [ ] User can send a new prompt to an existing session
- [ ] App exposes no create/fork/delete entry point; those lifecycle actions remain local
  to the machine running OpenCode
- [ ] Live streaming of agent responses (character-by-character)
- [ ] Diff cards render with proper syntax highlighting
- [ ] Permission requests show approve/reject buttons that work
- [ ] App handles connection loss gracefully (reconnect + offline cache)
- [ ] Release build rejects plaintext HTTP
- [ ] Tokens stored in secure storage, never in logs

---

## 13. Verified Transport Contract (2026-07-11 addendum — read before implementation)

Facts below were verified against the live deployment (OpenCode 1.17.14 backend,
hardened transparent proxy at opencode.example.com). They are binding for the
implementation; several override plausible-looking alternatives.

### 13.1 Architecture decision (final)

- The relay at `opencode.example.com` remains a **stateless OpenCode data proxy** (bearer ->
  Basic translation + target/directory policy). It owns only authentication/pairing
  state; there is no relay-side event history or session database. The relay-owned
  discovery surface is `GET /relay/targets`, which returns the current credential's
  authorized machine IDs and display names.
- A request selects one authorized machine with `X-OpenCode-Target`. The app enumerates
  every discovered machine independently, tags each session with its target ID, and
  sends all follow-up session/message/SSE operations back to that same target. Never
  infer target from a directory or assume session IDs alone are globally routable.
- Reconnect semantics are **server-authoritative refetch** (identical in principle to
  the TUI's attach behavior and to Codex/ChatGPT-mobile "reconnecting"): on reconnect,
  re-fetch the session list and the messages of any open session, then resubscribe
  `/event`. Missed events are never replayed; fresh reads supersede. Apply refetched
  state by replacement, not by merging.

### 13.2 Verified live-path facts

- Public SSE `/event` streams correctly through Cloudflare + Caddy + FRP (verified
  end-to-end). Cold first-connect can take longer than 8s: use a **first-byte timeout
  of at least 20s** plus standard reconnect backoff. The first event is
  `server.connected`.
- Bearer auth on every request (`Authorization: Bearer <token>`); missing/invalid
  tokens return 401 (verified). The relay-owned `/health` endpoint is the intentional
  unauthenticated exception.

### 13.3 Backend API gotchas (verified against 1.17.14 — will save you a day)

- `GET /session/:id/message`: **always pass a positive `limit`**. Omitted or `0`
  returns the ENTIRE session unbounded. Pagination: `before` cursor via
  `X-Next-Cursor` / `Link` headers; pages walk newest -> older, each page's items are
  oldest-first internally.
  Never follow the absolute `Link` target: the proxy can expose its internal
  `127.0.0.1:4096` origin. Extract `before` (prefer `X-Next-Cursor`) and rebuild the
  request from the configured public host URL.
- `POST /session/:id/prompt_async`: body must include `agent`, `model`
  (`{"providerID":"...","modelID":"..."}`), and `parts`. The `agent` must be a
  **primary-mode** agent (e.g. `build`); subagent-mode agent names are silently
  ignored — the user message lands and nothing else ever happens, with no error.
  Pass `?directory=<canonical-dir>` as a query parameter.
  The mobile client also sends the same value as `X-OpenCode-Directory` so relay
  pin/allowlist policy can run before proxying. A missing agent/model/directory is a
  client-side configuration error and must fail before network dispatch.
- **Never call `POST /sync/history`** — with an empty/partial vector it performs an
  unbounded global scan and can OOM the backend (reproduced live).
- **Do not build on `GET /api/session/:id/history`** — it filters a v2-only event
  namespace and returns empty for all TUI-driven sessions through at least v1.17.18.
- Session list for UI: `GET /session` (instance surface) supports
  `?start=<epochMs>` (sessions updated since) and orders by update time —
  useful for a cheap "what changed" refresh; `GET /api/session` orders by
  creation time with keyset cursors — useful for full enumeration.
- Full relay refresh: for every `GET /relay/targets` entry, paginate that target's
  `GET /api/session?limit=1000` with `X-OpenCode-Target`. The returned cursor is
  authoritative: continue while `X-Next-Cursor` (or the equivalent Link cursor) exists,
  even when the server returns fewer rows than requested. Page length is not a safe
  termination signal because a backend or proxy may cap a page below the requested
  limit. Normalize `session.location.directory` into the app's
  `session.directory` compatibility field. Workspaces are keyed by target + directory,
  so identical paths on two machines remain separate.

### 13.4 Response-shape facts

- Session timestamps are numeric values under `session.time.created` and
  `session.time.updated`; top-level string `created` / `updated` fields are compatibility
  allowances only.
- Current tool content normally arrives as `Part.type = "tool"` with state, input, output,
  and status nested in the part. Renderers may continue accepting legacy
  `tool_use` / `tool_result` shapes.
- `POST /session/:id/share` returns the authoritative public URL in session share metadata.
  Do not fabricate a relay `/session/:id` URL.

### 13.5 Reconnect state machine

1. Connect `/event` with a 20-second-or-longer first-byte timeout.
2. Apply live events while connected.
3. On stream end/error, refetch the session list and the open session's bounded message
   page, replacing server-authoritative state.
4. Resubscribe with bounded backoff. There is no event replay cursor.
5. User unsubscribe, host switch, and route teardown cancel both the active stream and any
   pending reconnect timer.

### 13.6 Live E2E ownership rules

- A test run may own no more than five sessions concurrently, including forks.
- Test-created IDs are registered immediately and deleted in reverse order in a test-only
  cleanup hook; cleanup must verify subsequent GET returns 404.
- The shipping app has no `deleteSession` action. Session lifecycle management remains on
  the machine running OpenCode.
- A test that uses ReactTestRenderer or mocked React Native is a live-backend integration
  test, not native iOS end-to-end proof.

### 13.7 Verification fingerprint

Live observations in this section currently identify OpenCode `1.17.14` at the public
endpoint. A customized daemon can retain that version string, so future contract updates
must also record the daemon revision, relay revision/deploy checksum, relay config schema,
verification date, and whether each result is local-only or confirmed on the VPS.

### 13.8 Question and session-state contract (verified live 2026-07-11)

- Pending questions are listed with `GET /question?directory=<canonical-dir>` and synchronized
  through `question.asked`, `question.replied`, and `question.rejected` SSE events.
- Reply and reject are workspace-scoped operations. Use
  `POST /question/:requestID/reply?directory=<canonical-dir>` or `/reject` and send the same
  directory in `X-OpenCode-Directory`. Omitting this scope can return
  `QuestionNotFoundError` even when the request was just observed on a scoped SSE stream.
- A question request contains `questions[]`; replies are ordered `answers: string[][]`.
  Transcript `tool: question` parts are historical content, not the pending queue.
- Refetch/SSE ordering must be race-safe. If a reply/reject event arrives while an older
  `GET /question` is in flight, the old response cannot reinsert the removed request.
- `GET /session` includes both roots and child sessions. General Recent/session/workspace
  navigation filters out any session with `parentID`; child transcripts remain available
  from subagent-specific navigation.
- Selectable agents follow the TUI filter: `mode !== "subagent" && !hidden`.

### 13.9 Passkey Dashboard and permanent device credential contract (2026-07-13)

- Normal onboarding is zero-entry: open the configured relay origin in a browser,
  authenticate the owner with a user-verified WebAuthn passkey, press **Connect phone**,
  and scan the generated HTTPS QR with iPhone Camera.
- The QR carries an HTTPS mobile landing URL. Its pairing code lives in the URL fragment,
  is random, single-use, stored only in relay memory, and expires after two minutes. The
  landing page opens `opencode://pair?origin=...&code=...`; the app exchanges the code at
  `POST /api/pairing/exchange` without an existing Authorization header.
- A successful exchange returns one Bearer credential. The app stores it in iOS secure
  storage and persists/activates the connection automatically. The relay persists only a
  SHA-256 credential hash plus the inherited target/directory scope.
- The paired credential has **no time-based expiry** and survives relay/app restarts. It
  remains valid until the owner revokes it; app reinstall or Keychain deletion can still
  remove the phone's local copy.
- The passkey-authenticated Dashboard lists device name, pairing time, and last-use time.
  `POST /api/pairing/revoke` deletes the credential, closes its active SSE connections,
  and causes all future requests to fail authentication immediately.
- WebAuthn origin/RP ID are derived from the exact HTTPS `RELAY_PUBLIC_ORIGIN`. First
  registration additionally requires a private bootstrap fragment secret and is disabled
  after the first passkey is stored. Dashboard mutation requests require both the
  HttpOnly/SameSite web session and an exact same-origin `Origin` header.
- New phones inherit the targets and directory restrictions of
  `PAIRING_SOURCE_CLIENT_ID`; pairing never grants broader machine access than that source.

## 14. Existing-session mobile control contract (2026-07-14 addendum)

This section overrides the earlier project/new-session/workbench screen sketches and the
old acceptance criterion that mobile creates a session. The shipping mobile app discovers,
monitors, and controls **existing** OpenCode sessions; session creation, fork, and deletion
remain on the machine running OpenCode.

### 14.1 Composite identity and discovery

- A connection can authorize any number of relay targets. The app must discover targets
  from `GET /relay/targets`; machine IDs, labels, directories, agents, models, and
  reasoning variants must never be hard-coded.
- The `name` returned for a target by `GET /relay/targets` is its canonical current
  display name. Mobile must not invent a hostname-based or platform-based label. A fresh
  discovery response also relabels retained cached sessions for an unreachable target, so
  a Dashboard rename remains visible during partial failure.
- The only globally safe session identity is
  `(connectionID, targetID, sessionID)`. Every cache key, route, selection, follow-up REST
  request, and SSE reconciliation must preserve all three components.
- Session roots from every reachable target are merged for display and sorted by the
  authoritative update time, newest first. Search matches title, machine label, directory,
  and ID with a 150 ms debounce, matching current OpenCode TUI behavior.
- A partial target failure must keep healthy machines and cached data visible while showing
  the failed machine/error. It must not collapse the entire connection into a false global
  offline state.

### 14.2 Navigation and hierarchy safety

- Initial synchronization and transcript opening are explicit blocking states. While a
  session navigation is in flight, its card is disabled and repeated taps are ignored.
- Opening the same composite session replaces/reuses its route rather than stacking
  duplicate screens.
- The hierarchy view is a full-depth forest. Orphans, self-parent links, and cycles remain
  visible as guarded roots; malformed server data can never recurse forever or make a
  session unreachable.
- General Sessions shows only records whose `parentID` is absent. A record with a non-empty
  `parentID` is never promoted into Recent, workspace, machine-filter, search, or general
  `@session` results, even if its parent is missing, self-referential, or part of a cycle.
  Forest anomaly recovery belongs only to hierarchy/diagnostic navigation. Descendants
  remain reachable from the session hierarchy; mobile must not fabricate parent/child
  relationships from titles, agents, or directories.

### 14.3 Machine execution contract

- Opening an existing session fetches that session's target-specific agent/model contract.
  Selectable agents follow `mode !== "subagent" && !hidden`; deprecated/unavailable models
  are not offered.
- The selected agent, provider/model pair, and reasoning variant are restored from real
  session/message state where available and validated against the fresh machine contract.
- Contract state is explicit: `unverified`, `loading`, `fresh`, `stale`, or `error`. Only a
  `fresh` contract may dispatch. A cached/stale contract may render the previous selection,
  but it must not be used to send a network request.
- Model and reasoning pickers contain only values returned by the selected machine. A model
  change recomputes the reasoning choices from that model's contract.

### 14.4 Connectivity, cache, and transcript performance

- Transport state is explicit: `idle`, `connecting`, `live`, `reconciling`, or `offline`.
  Intentional unsubscribe/route teardown is `idle`, not `offline`.
- Reconnect uses server-authoritative replacement as defined in section 13.5. A single-flight
  guard prevents overlapping full refresh/open requests from racing older data back in.
- Cache is a continuity surface, not proof of connectivity. Cached sessions/transcript stay
  visible with a concise warning; live controls are gated until their required target and
  contract are fresh.
- Long transcripts use a virtualized list. Expensive message/tool rendering and callbacks
  must be referentially stable so unrelated prompt/control changes do not rerender every
  historical message.

### 14.5 Native system boundary

- App Intents expose one open-app action, **Open OpenCode Sessions**, handed off through
  `opencode://sessions`. There is no free-form session/prompt intent because a bare session
  ID cannot preserve the composite target identity.
- A Release Simulator build, runtime relay round-trip in the exact designated test session,
  ETTrace sample, and native memgraph leak check are release evidence; React Native Web
  alone is not sufficient for this contract.
