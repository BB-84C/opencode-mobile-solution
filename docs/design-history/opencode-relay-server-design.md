# OpenCode Relay Server and Exact Sync Design

**Date:** 2026-07-10  
**Status:** Approved design, pending implementation plan and live cutover approval  
**Tracking:** Local-only report under `.reports/`; do not commit without explicit approval

## 1. Purpose

Provide one persistent OpenCode backend on the Windows host and make every normal local TUI a disposable client of that backend. Keep the FRP transport independent from TUI lifetime. Add an application-aware relay synchronization protocol so a remote client can recover exactly after a tunnel interruption for the event classes OpenCode persists durably.

The design has two cooperating but separately managed layers:

1. **Windows relay-server controller** — owns the local OpenCode backend lifecycle and local TUI attach behavior.
2. **VPS OpenCode relay** — preserves the existing bearer-to-Basic authentication proxy and adds exact incremental synchronization above FRP.

The mobile application is explicitly out of scope for this implementation round. After the relay protocol is implemented and accepted, update the mobile specification for a separate Codex implementation pass.

## 2. Approved decisions

- Use one shared OpenCode backend on `127.0.0.1:4096`.
- `frpc` does not bind local port 4096. It dials the OpenCode listener at `localPort = 4096`; `frps` owns `remotePort = 4096` on the VPS.
- The FRP daemon and OpenCode backend have independent lifecycles.
- Remove the Ctrl+P `Restart OpenCode Server` plugin after the new controller passes cutover acceptance.
- `opencode --relay_server start` explicitly starts or ensures the persistent backend and tunnel.
- A bare `opencode` does not start the persistent backend. It attaches when the authenticated relay backend is available; otherwise it prints a visible warning and launches a standalone local TUI.
- Preserve `opencode --local` as an explicit escape hatch.
- Forward official OpenCode session flags, including `-s` / `--session`; do not add `-ses`.
- A backend restart is an intentionally disruptive operator command. It exits all wrapper-managed attached local TUIs, interrupts in-process agent work, restarts the shared backend, and requires manual session/agent recovery.
- Keep a five-second best-effort abort/cleanup window before forced backend termination. This reduces torn tool operations but never blocks the requested restart indefinitely.
- Implement exact incremental synchronization in the relay before updating the mobile specification.
- Launch the persistent backend through a tiny cross-platform Node helper using `child_process.spawn()` with `detached: true`, direct native-executable invocation, file-backed stdio, and `unref()`. Do not use WMI, Task Scheduler, `cmd.exe`, PowerShell, or an OS service manager as the daemonization boundary.

## 3. Existing substrate

### 3.1 Windows launcher

Current files:

- `~/.config/opencode/bin/opencode.cmd`
- `~/.config/opencode/bin/opencode-serve-attach.ps1`
- `~/.config/opencode/plugins/opencode-restart/tui.mjs`
- `~/.config/opencode/tui.jsonc`

Current defects:

- An unauthenticated `401` health response is treated as healthy.
- The persistent backend and later attach clients can inherit different environment snapshots.
- Port presence is treated as process ownership.
- Restart uses one consumable global marker and an unverified force-kill of the port owner.
- Any TUI can consume another TUI's restart request.
- The custom `-u` usage alias conflicts with upstream `attach -u` username semantics.

### 3.2 VPS relay

Current files:

- `opencode-relay/relay.mjs`
- `opencode-relay/tokens.example.json`
- `opencode-relay/opencode-relay.service`
- `opencode-relay/README.md`

The current relay is a 219-line, zero-dependency Node.js proxy. It:

- validates per-device bearer tokens;
- replaces bearer authentication with upstream Basic authentication;
- optionally supplies an OpenCode directory header;
- transparently pipes all OpenCode HTTP and SSE responses;
- keeps no event sequence, cursor, checkpoint, replay state, or backend epoch.

### 3.3 Native OpenCode synchronization capability

The deployed OpenCode `1.17.14` OpenAPI document confirms these authenticated endpoints:

```text
POST /sync/history
POST /sync/replay
POST /sync/start
POST /sync/steal
GET  /global/event
GET  /event
```

`POST /sync/history` accepts a per-aggregate sequence vector:

```json
{
  "ses_example": 14,
  "ses_example": 8
}
```

It returns durable events where `seq` is greater than the supplied sequence for a known aggregate, and the complete history for aggregates omitted from the vector:

```json
[
  {
    "id": "evt_...",
    "aggregate_id": "ses_example",
    "seq": 15,
    "type": "...",
    "data": {}
  }
]
```

The upstream implementation stores durable events and per-aggregate sequence fences in OpenCode's SQLite database. The native control-plane implementation already uses the same algorithm required here:

1. subscribe to live events;
2. send the locally known sequence vector to `/sync/history`;
3. replay missing durable events;
4. deduplicate buffered live events;
5. continue live delivery.

This capability is the canonical durable source. The VPS relay must not duplicate entire conversation bodies into a second durable journal unless a future requirement proves the native history insufficient.

## 4. Target topology

```text
Local TUI A --\
Local TUI B ----> OpenCode serve 127.0.0.1:4096
Local TUI C --/          ^
                        | frpc dials localPort 4096
                        |
                  SSH local transport
                        |
                  VPS frps remotePort 4096
                        |
              VPS relay 127.0.0.1:4097
              - bearer authentication
              - Basic upstream authentication
              - native-history sync broker
                        |
                    Caddy / TLS
                        |
                 opencode.example.com
```

The Windows controller is not an HTTP proxy and does not bind 4096. OpenCode remains the only local listener on that port.

## 5. Windows relay-server controller

### 5.1 Command surface

```text
opencode --relay_server start
opencode --relay_server status [--json]
opencode --relay_server restart
opencode --relay_server restart tunnel
opencode --relay_server stop
opencode --relay_server stop tunnel
opencode --relay_server doctor [--json]
opencode --local [...original args]
```

`opencode --relay_server restart` means backend restart. It does not restart FRP.

### 5.2 `start`

`start` is idempotent:

1. Acquire a user-scoped Windows named mutex.
2. Rehydrate `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_PORT`, and tunnel configuration from Windows User scope rather than trusting the caller's inherited process environment.
3. Inspect the unique `Listen` socket on 4096.
4. If a recorded managed backend is healthy and its PID, creation time, executable path, version, authenticated health response, and listener PID agree, return success.
5. If a foreign or ambiguous listener owns 4096, fail closed and never kill it.
6. If no managed backend exists, invoke the short-lived Node daemon launcher. It starts the resolved real OpenCode executable directly by absolute path with `serve --hostname 127.0.0.1 --port 4096`, detached from the controller, with stdin ignored and stdout/stderr opened in append mode under the controller state root.
7. Require authenticated `200` responses from `/global/health` and `/config` before declaring readiness.
8. Ensure the SSH/frpc transport independently and report its health separately.

The daemon launcher is a process primitive, not a second supervisor. The PowerShell controller remains authoritative for mutexes, state, identity verification, health, restart, and stop. The launcher receives a non-secret JSON launch envelope over stdin, inherits credentials only through its process environment, waits for Node's `spawn` event, emits one JSON handshake containing the direct child PID, closes its copies of the log file descriptors, calls `unref()`, and exits. It uses `shell: false`; on Windows the controller resolves `opencode.cmd` to the actual `opencode.exe` before invocation.

The launch is accepted only when the handshake PID is the sole listener owner and its creation time, executable, command, version, and authenticated health all match. A launcher exit, malformed handshake, unexpected intermediate shell, or listener mismatch is a failed attempt and triggers cleanup only for identities captured from that attempt.

### 5.3 Bare `opencode`

Interactive invocations are:

```text
opencode
opencode --dir <path>
opencode -c | --continue
opencode -s | --session <session-id>
opencode --fork
opencode --mini
```

For these forms:

1. Resolve the effective directory explicitly; default to the caller's current directory.
2. Rehydrate User-scope credentials.
3. Run authenticated `/global/health` and `/config` preflight checks against `127.0.0.1:4096`.
4. If preflight succeeds, run `opencode attach http://127.0.0.1:4096 --dir <effective-directory>` and forward session flags unchanged.
5. If connectivity/authentication preflight fails, print to stdout:

```text
[WARN] Relay backend at 127.0.0.1:4096 is unavailable.
[WARN] Starting local OpenCode. This session will not be visible through opencode.example.com.
```

6. Launch the original local OpenCode command with the user's arguments.

Do not fallback after arbitrary attach exits. Normal Ctrl+D, invalid session IDs, directory/session mismatch, plugin failures, and argument failures must retain their original result rather than spawning an unexpected local TUI.

`opencode --local` bypasses all checks and directly launches the original OpenCode command.

### 5.4 Managed TUI registry

Every wrapper-started attach TUI registers a lease containing:

```text
attach PID
parent wrapper PID
process creation time
backend generation
directory
optional session ID
last heartbeat
```

The controller may act only on a lease whose PID, creation time, executable path, parent relationship, and backend generation still agree. It never terminates `--local` TUIs, direct unmanaged attaches, or unknown OpenCode processes.

### 5.5 Backend restart

The restart command is explicit operator authorization for a disruptive shared-backend restart:

1. Acquire the lifecycle mutex.
2. Verify the managed backend identity and port ownership.
3. Mark controller state `RESTARTING`; reject new managed attaches.
4. Request graceful exit from all verified managed attach TUIs, then terminate only those owned processes that do not exit within the bounded client-exit timeout.
5. Send best-effort abort requests for known active sessions.
6. Wait five seconds for normal tool/session cleanup.
7. Terminate the verified backend process tree.
8. Confirm old PID exit and port release before starting anything new.
9. Start the next backend generation using the same OpenCode data directory and canonical credentials.
10. Require authenticated health and config readback.
11. Persist the new generation and reopen managed attach admission.

FRP remains running. Existing remote sockets fail during backend downtime and recover through relay synchronization after the new backend is ready.

The contract does not promise side-effect-free interruption. Committed session history should survive, but in-flight tools may have partially changed files, repositories, hardware, or external systems. Interrupted tools are never replayed automatically.

### 5.6 Tunnel restart

`restart tunnel` restarts only SSH/frpc. Local TUI and backend processes remain untouched. The VPS relay detects the upstream gap, retains remote client connections where possible, and uses native history to backfill durable events after transport recovery.

## 6. Exact relay synchronization

### 6.1 Exactness claim

The relay provides:

- **exact, incremental, at-least-once recovery** for event classes persisted by OpenCode's native sync history;
- effectively-once client state when the client applies events idempotently by upstream event ID and per-aggregate sequence;
- explicit gap and snapshot requirements for volatile state not present in native history.

It does not claim:

- a single global causal order across unrelated aggregates;
- exactly-once network delivery;
- replay of in-memory events OpenCode never persisted;
- automatic continuation of an agent interrupted by backend process death.

### 6.2 Durable and volatile domains

The native history is authoritative for its versioned durable event union, including session/message/part mutations and removals exposed by the deployed event manifest.

Volatile domains such as live status, partial deltas, permission prompts, questions, diffs, todos, PTY state, MCP/LSP state, and process state must be marked dirty and re-read from authoritative REST endpoints after an upstream gap unless runtime capability probing proves a domain durable.

### 6.3 Scope identity

A sync stream is bound to:

```text
target backend
canonical effective directory
workspace, when supplied
authorization scope
```

The relay must separate stable client identity from display name. The token object key becomes `client_id`; `name` remains display-only. Token rotation must not silently change client identity.

The relay always strips client-provided `x-opencode-directory` before applying the token's pinned directory or a validated directory allowed by that token's policy.

### 6.4 Relay protocol endpoints

Keep all existing OpenCode paths transparent, including legacy `/event`. Add a relay-owned namespace:

```text
GET  /relay/v1/sync/capabilities
POST /relay/v1/sync/stream
GET  /relay/v1/sync/status
```

All sync routes require the same bearer authentication as proxied OpenCode routes.

#### Capabilities

`GET /relay/v1/sync/capabilities` reports only protocol metadata:

```json
{
  "protocol": 1,
  "mode": "opencode-native-history",
  "durableHistory": true,
  "liveStream": true,
  "scope": {
    "directoryRequired": true,
    "workspaceSupported": true
  },
  "delivery": "at-least-once",
  "ordering": "per-aggregate",
  "volatileRecovery": "snapshot"
}
```

Do not expose credentials, absolute directory policy, event contents, or device tokens.

#### Sync stream request

The future app opens a streaming `POST` request so it can supply an arbitrarily sized per-aggregate vector without encoding it into a URL:

```http
POST /relay/v1/sync/stream?directory=<canonical-directory>
Authorization: Bearer <device-token>
Content-Type: application/json
Accept: text/event-stream

{
  "protocol": 1,
  "known": {
    "ses_example": 14,
    "ses_example": 8
  }
}
```

The body describes the last **durably applied** sequence per aggregate. A stale vector causes duplicate delivery, not omission. The client must advance a vector entry only after the corresponding state mutation and vector update are durably persisted together.

#### Stream frames

Relay control frames use the `relay.*` namespace:

```text
event: relay.sync.begin
data: {"protocol":1,"scopeID":"...","mode":"opencode-native-history"}

event: relay.sync.ready
data: {"durableCaughtUp":true,"dirtyDomains":["status","permission","question"]}

event: relay.upstream.disconnected
data: {"reason":"transport_gap","retrying":true}

event: relay.upstream.reconnected
data: {"historyBackfilled":true,"dirtyDomains":[...]}

event: relay.reset
data: {"reason":"backend_data_reset|scope_changed|protocol_changed"}
```

Durable OpenCode events are normalized without losing source fields:

```text
event: relay.durable
id: evt_...
data: {
  "id":"evt_...",
  "aggregateID":"ses_example",
  "seq":15,
  "type":"...",
  "data":{}
}
```

Live non-durable events use:

```text
event: relay.volatile
data: {
  "sourceType":"...",
  "payload":{}
}
```

Heartbeat comments do not advance any cursor:

```text
: ping
```

### 6.5 Upstream broker algorithm

Create one broker per active sync scope. A broker owns one upstream event subscription and one sequence vector.

#### Initial broker bootstrap

1. Load the last persisted scope vector, if any.
2. Open the scope's live OpenCode event subscription first and buffer incoming events.
3. POST the persisted vector to `/sync/history`.
4. Replay every returned durable event through the broker reducer.
5. Deduplicate buffered durable events by upstream event ID and `(aggregateID, seq)`.
6. Drain the buffer.
7. Enter live mode.

If no vector exists, `{}` requests complete native history. The relay scans it to establish the current fence. It need not retain conversation bodies after processing.

#### Client resume

For each client `known` vector:

1. The broker guarantees a live subscription is already registered or registers one before querying history.
2. Call `/sync/history` with the client's vector and matching directory/workspace scope.
3. Emit missing durable events in per-aggregate sequence order.
4. Buffer live events during the history query.
5. Deduplicate history and buffer by event ID.
6. Emit `relay.sync.ready`.
7. Continue live fanout.

OpenCode history uses sequences per aggregate. The relay may assign an ephemeral transport order for framing, but it must not represent that order as a causal ordering between different sessions.

#### Tunnel interruption

When the upstream event connection drops while the VPS relay remains alive:

1. Keep downstream connections open with heartbeat comments where possible.
2. Emit `relay.upstream.disconnected`.
3. Stop forwarding mutations from an unverified upstream connection.
4. Reconnect with bounded exponential backoff.
5. Register live buffering before requesting history.
6. POST the broker's last durable vector to `/sync/history`.
7. Emit every missing durable event.
8. Mark volatile domains dirty.
9. Emit `relay.upstream.reconnected` and resume live fanout.

This closes the exact durable gap even if OpenCode generated events while FRP was unavailable.

#### Relay restart

The relay persists only non-sensitive scope vectors and protocol metadata. After restart it repeats broker bootstrap against `/sync/history`. If the persisted vector is stale, OpenCode returns duplicates/missing deltas safely. If the vector file is absent, the broker performs a complete history scan.

#### Backend restart

If the OpenCode database survives, native history remains available and the broker uses the same gap-recovery path. Volatile domains require snapshot refresh, and any prior active turn is reported as interrupted or unknown rather than resumed.

If the backend data store is reset, replaced, or regresses behind a previously acknowledged vector, the relay emits `relay.reset`. The future app must discard only the affected scope and perform a full authoritative snapshot.

### 6.6 Metadata persistence and privacy

Persist only:

```text
protocol/schema version
scope identity hash
per-scope aggregate sequence vector and last event ID anchor
last successful upstream contact
last reset reason
```

Do not persist prompts, model text, reasoning, tool input/output, diffs, attachments, or raw event bodies on the VPS. Native OpenCode history remains the content journal.

The state file may use an atomically replaced JSON representation because stale metadata causes replay duplicates rather than data loss:

1. serialize to a temporary file;
2. flush the file;
3. rename over the prior state;
4. keep the prior valid state on parse/reload failure.

On every upstream reconnection, validate each known aggregate anchor instead of assuming a high client sequence still belongs to the current backend database. For an aggregate whose last known event is `(eventID, seq)`, request history from `max(seq - 1, 0)`. The returned suffix must contain the same anchor event before any newer events. A missing or mismatched anchor means the backend history was reset, replaced, or pruned; increment the relay scope generation and emit `relay.reset` rather than silently continuing from an unrelated sequence space.

Use a dedicated systemd state directory, not `/etc`:

```text
/var/lib/opencode-relay/sync-state.json
```

Recommended service settings:

```ini
StateDirectory=opencode-relay
StateDirectoryMode=0700
UMask=0077
```

### 6.7 In-memory limits and backpressure

The broker may keep a bounded transient ring only for history/live handoff and short client backpressure. It is not the durable source.

Initial limits:

```text
SYNC_BUFFER_MAX_EVENTS=10000
SYNC_BUFFER_MAX_BYTES=33554432
SYNC_CLIENT_QUEUE_MAX_BYTES=8388608
SYNC_HEARTBEAT_SEC=20
SYNC_RECONNECT_MIN_MS=500
SYNC_RECONNECT_MAX_MS=30000
```

When a client exceeds its queue limit, close that client with an explicit resync requirement. Never allow one stalled phone to block the upstream collector or exhaust the 128 MiB service limit.

### 6.8 Reverse-proxy requirements

Sync SSE responses must include:

```text
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
Connection: keep-alive
```

Caddy/nginx must not buffer or compress sync streams. Keepalive comments must traverse Caddy/Cloudflare for longer than existing proxy idle timeouts.

## 7. Relay file boundaries

Refactor the current single entrypoint only as needed:

```text
opencode-relay/
  relay.mjs                  # HTTP entrypoint and route dispatch
  lib/config.mjs             # validated token/config loading
  lib/auth.mjs               # stable client identity and auth translation
  lib/proxy.mjs              # transparent OpenCode proxy
  lib/sse-codec.mjs          # byte-safe incremental SSE parsing/framing
  lib/sync-broker.mjs        # scoped upstream collectors and gap recovery
  lib/sync-protocol.mjs      # relay control envelopes and validation
  lib/sync-state.mjs         # atomic metadata-vector persistence
  test/*.test.mjs            # Node built-in tests
```

No OpenCode fork is required. Legacy `/event` and every existing REST route remain transparent for compatibility.

## 8. Configuration migration

Introduce a validated v2 configuration while accepting the current token format during migration:

```json
{
  "version": 2,
  "targets": {
    "home-opencode": {
      "host": "127.0.0.1",
      "port": 4096,
      "basic_user": "opencode",
      "basic_pass": "..."
    }
  },
  "clients": {
    "my-iphone": {
      "display_name": "example iPhone",
      "token": "...",
      "target": "home-opencode",
      "directory": null,
      "allowed_directories": null
    }
  }
}
```

Validate the complete replacement configuration before swapping the hot-reload cache. A malformed update must retain the last valid configuration. Removing a token must reject new requests and close its active sync streams within the reload interval.

Security fixes included in the migration:

- stable client ID must not be overwritten by display name;
- always remove an incoming directory header before applying policy;
- reject missing Basic passwords rather than encoding `undefined`;
- align `TOKENS_PATH` and `TOKEN_RELOAD_SEC` names across code, service, and documentation;
- do not log authorization values or sync payloads;
- rotate the exposed bearer/Basic credentials during the separately approved live cutover.

## 9. App handoff contract

No mobile application code or app specification changes occur in this implementation round.

After the relay protocol passes acceptance, update the mobile specification to require:

- feature detection through `/relay/v1/sync/capabilities`;
- streaming POST resume with a per-aggregate vector;
- atomic persistence of projected state and vector advancement;
- idempotent apply by upstream event ID and aggregate sequence;
- explicit `STALE`, `RESYNCING`, `BACKEND_RESTARTED`, and `RESET_REQUIRED` states;
- disabled mutations during reconciliation;
- authoritative REST refresh for dirty volatile domains;
- no automatic retry of a mutation whose outcome is unknown;
- manual recovery of turns interrupted by backend restart.

That specification is handed to the app-specific Codex worker only after relay evidence exists.

## 10. Acceptance plan

### 10.1 Local controller tests

| Scenario | Semantic pass condition |
|---|---|
| User-scope password exists but caller process env is stale | Authenticated preflight and attach succeed after explicit rehydration |
| No listener on 4096 | Bare `opencode` prints the two fallback warnings and starts standalone local OpenCode |
| Authenticated health fails | Same explicit local fallback; no hidden persistent backend creation |
| Healthy backend | Bare `opencode` attaches with the exact current directory |
| Invalid `-s` session after healthy preflight | Original attach error is preserved; no local fallback launches |
| Normal Ctrl+D detach | Wrapper exits; backend and tunnel generations do not change |
| Concurrent `--relay_server start` | One managed backend generation and one listener result |
| Foreign process owns 4096 | Start/restart refuses and does not terminate the foreign PID |
| Credential drift | `doctor` distinguishes User-scope, Process-scope, anonymous 401, and authenticated 200 without printing secrets |
| `--local` | Original OpenCode launches without relay probes or managed lease registration |
| Backend restart with several managed TUIs | Every verified managed attach exits; unmanaged/local processes remain; backend generation advances once |
| Restart during an active tool | Committed history survives; interrupted outcome is reported as uncertain; no tool is replayed automatically |
| Tunnel restart | Local backend and local TUIs remain continuously usable |

### 10.2 Relay unit and integration tests

| Scenario | Semantic pass condition |
|---|---|
| SSE chunk boundaries | CRLF/LF, comments, multiline data, split UTF-8, `id`, and named events round-trip correctly |
| History vector | For every aggregate, only events with `seq > known[aggregate]` are emitted; omitted aggregates receive full history |
| History/live race | Events created during history query appear exactly once by event ID after deduplication |
| Per-aggregate ordering | Sequence increases monotonically within each aggregate; no false cross-aggregate causal claim is made |
| Client reconnect | A stale client vector causes replay; final projected transcript equals authoritative REST readback |
| Duplicate delivery | Reapplying the same event ID/vector does not duplicate state |
| Tunnel outage | Durable events produced locally during outage are recovered through `/sync/history` after reconnect |
| Relay process restart | Persisted vector resumes history without omission; stale vector may duplicate but never skip |
| Backend restart, same database | Durable session/message/part history is recovered; volatile domains are marked dirty |
| Backend data reset/regression | Relay emits `relay.reset`; it never treats a lower sequence as continuation |
| Multiple clients | Independent client vectors do not block one another; one upstream collector serves each scope |
| Slow client | Queue remains bounded; slow client is disconnected for resync; other clients and collector continue |
| Token revocation | New requests fail and existing sync stream closes within the reload window |
| Directory policy | Incoming header is stripped; pinned/allowed directory policy is authoritative |
| Legacy compatibility | Existing `/event` and arbitrary OpenCode REST routes remain byte-compatible |
| Reverse proxy | Sync frames arrive incrementally through Caddy/Cloudflare for longer than configured idle timeouts |

### 10.3 Production semantic scenario

The load-bearing relay acceptance run is:

1. Start one isolated test backend and relay scope.
2. Establish client vector `V` and disconnect the simulated remote client.
3. Start a real asynchronous OpenCode turn that writes several durable message/part events.
4. Interrupt only the FRP transport while the backend continues.
5. Allow the turn to finish.
6. Restore FRP.
7. Resume through `/relay/v1/sync/stream` with vector `V`.
8. Apply every returned durable event idempotently.
9. Compare the reconstructed session/message/part tree with direct authenticated REST readback from OpenCode.
10. Repeat after a relay process restart.
11. Repeat after an idle backend restart using the same OpenCode database.

Pass requires semantic equality of the reconstructed durable state. Frame counts, successful HTTP status, or the presence of a final assistant message are insufficient substitutes.

## 11. Rollout and permission boundaries

Implementation and validation proceed in this order:

1. Build controller and relay changes without touching the current live 4096 process.
2. Run controller lifecycle tests on an alternate local port and isolated state directory.
3. Run relay protocol tests against a fake upstream and an isolated OpenCode backend.
4. Deploy relay code with native-history sync endpoints disabled by default.
5. Validate transparent proxy compatibility.
6. Enable broker ingestion for a test scope and verify sequence-vector progress.
7. Run the production semantic scenario with a throwaway session.
8. Request explicit permission before terminating or replacing the current shared backend.
9. Perform live cutover, authenticated readback, and tunnel/public endpoint verification.
10. Remove the Ctrl+P restart plugin only after the controller and new bare-command behavior pass live acceptance.
11. Rotate exposed bearer and Basic credentials only with explicit approval and coordinated VPS/local updates.
12. After relay acceptance, update the mobile specification; do not implement the app in this round.

## 12. Non-goals

- No OpenCode core fork.
- No port-per-directory or port-per-session backend fleet.
- No transparent continuation of a turn interrupted by backend restart.
- No automatic tool replay after uncertain interruption.
- No mobile application implementation in this round.
- No durable storage of conversation bodies on the VPS relay.
- No claim that volatile events are recoverable when OpenCode itself does not persist them.
- No git commit, service restart, public deployment, credential rotation, or live 4096 termination without the required explicit approval.

## 13. Design self-review

- **Placeholder scan:** no TBD/TODO requirements remain.
- **Consistency:** one backend owns local 4096; frpc only dials it; the controller does not bind an HTTP port; the VPS relay owns synchronization above FRP.
- **Exactness boundary:** exact incremental recovery is explicitly limited to native durable history. Volatile state uses authoritative refresh rather than false replay guarantees.
- **Restart semantics:** backend restart is intentionally disruptive and forceful, but process identity checks and a bounded cleanup attempt remain mandatory.
- **Fallback semantics:** fallback occurs only after authenticated connectivity preflight failure, never after arbitrary attach exit.
- **Privacy:** only sync vectors and protocol metadata persist on the VPS; event bodies remain in the Windows OpenCode database.
- **Scope:** controller, relay, tests, deployment metadata, and later app-spec handoff are included; app code is excluded.
- **Reversibility:** legacy transparent proxy routes remain unchanged, the plugin is removed only after cutover, and relay sync can remain feature-disabled until acceptance passes.
