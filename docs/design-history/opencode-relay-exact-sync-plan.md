# OpenCode VPS Relay Exact-Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing bearer-to-Basic VPS relay with exact incremental recovery for OpenCode's durable sync-history events while preserving every existing REST route and legacy `/event` stream.

**Architecture:** Add a relay-owned `/relay/v1/sync/*` namespace and one scoped upstream broker per directory/workspace. The broker subscribes live first, backfills gaps through deployed OpenCode `POST /sync/history`, deduplicates by upstream event ID and per-aggregate sequence, persists only sequence anchors, and marks non-durable domains dirty for authoritative REST refresh. Conversation bodies remain in the Windows OpenCode database, not on VPS disk.

**Tech Stack:** Node.js 22+ ESM built-ins, `node:test`, HTTP/SSE, atomic JSON metadata state, systemd, Caddy/nginx, OpenCode 1.17.x native sync/history API. No mobile application changes in this plan.

**Execution constraints:** Work in the existing opencode-vps checkout; do not create a worktree. Do not commit, deploy, restart systemd, alter Caddy/Cloudflare, rotate credentials, or touch the live tunnel without explicit authorization. All production-shape tests first run against fake and isolated upstreams.

---

## File structure

- Create: `opencode-relay/package.json` — zero-dependency test scripts and pinned Node engine.
- Modify: `opencode-relay/relay.mjs` — small entrypoint and route dispatch only.
- Create: `opencode-relay/lib/config.mjs` — validated v1/v2 config and hot reload.
- Create: `opencode-relay/lib/auth.mjs` — stable client identity and bearer-to-Basic policy.
- Create: `opencode-relay/lib/proxy.mjs` — existing transparent proxy behavior.
- Create: `opencode-relay/lib/sse-codec.mjs` — incremental SSE parser and encoder.
- Create: `opencode-relay/lib/sync-state.mjs` — atomic per-scope vector/event-anchor metadata.
- Create: `opencode-relay/lib/opencode-sync-client.mjs` — authenticated history and live-event calls.
- Create: `opencode-relay/lib/sync-broker.mjs` — subscribe-first/history-backfill/live fanout state machine.
- Create: `opencode-relay/lib/sync-protocol.mjs` — capabilities, streaming request validation, and relay frames.
- Create: `opencode-relay/test/*.test.mjs` — unit/integration/fault tests using `node:test`.
- Modify: `opencode-relay/opencode-relay.service` — state directory, limits, and shutdown settings.
- Modify: `opencode-relay/README.md` — protocol, exactness boundary, FRP topology, and proxy configuration.
- Modify later with permission: `config/Caddyfile` and deployment scripts.

### Task 1: Add test scaffolding and preserve transparent proxy behavior

**Files:**
- Create: `opencode-relay/package.json`
- Create: `opencode-relay/test/helpers/fake-upstream.mjs`
- Create: `opencode-relay/test/proxy-compat.test.mjs`

- [ ] **Step 1: Add the package/test contract**

```json
{
  "name": "opencode-relay",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "test:all": "node --test test/**/*.test.mjs"
  }
}
```

- [ ] **Step 2: Build a fake OpenCode upstream**

Create a helper returning `{ server, url, requests, publishEvent, addHistoryEvent, disconnectEvents }`. It must implement authenticated `/global/health`, `/config`, `/event`, `/global/event`, and `POST /sync/history` using an in-memory event table:

```js
const missing = events.filter((event) => {
  const known = body[event.aggregate_id];
  return known === undefined || event.seq > known;
});
```

The event endpoint must register listeners before sending `server.connected`, allowing tests to mutate during history reads.

- [ ] **Step 3: Write characterization tests for current proxy behavior**

Cover arbitrary methods, query strings, JSON/binary bodies, status/headers, bearer removal, Basic insertion, `Host` replacement, directory policy, chunked responses, upstream 502/504, and byte-compatible legacy `/event` piping.

- [ ] **Step 4: Run tests against current `relay.mjs`**

Run:

```bash
node --test test/proxy-compat.test.mjs
```

Expected: transparent paths pass; security assertions for unconditional directory-header stripping and missing Basic-password validation fail.

- [ ] **Step 5: Review checkpoint**

Preserve the characterization tests before refactoring. Do not commit.

### Task 2: Extract validated configuration and authentication

**Files:**
- Create: `opencode-relay/lib/config.mjs`
- Create: `opencode-relay/lib/auth.mjs`
- Create: `opencode-relay/test/config-auth.test.mjs`
- Modify: `opencode-relay/relay.mjs`

- [ ] **Step 1: Write failing v1/v2 and auth tests**

Test:

- current `tokens` config migrates in memory;
- v2 `targets`/`clients` parses;
- malformed hot reload retains the last valid snapshot;
- missing token/basic password fails closed;
- token object key remains stable `clientID` even when display name differs;
- timing-safe bearer validation works;
- incoming `x-opencode-directory` is always removed;
- pinned directory overrides the client;
- unrestricted owner token may provide a canonical absolute directory;
- a disallowed directory returns `403`.

- [ ] **Step 2: Run tests and verify failure**

Expected: modules missing.

- [ ] **Step 3: Implement normalized configuration types**

Use this internal shape:

```js
{
  version: 2,
  targets: new Map([[targetID, { host, port, basicUser, basicPass }]]),
  clients: new Map([[clientID, {
    clientID, displayName, token, targetID, pinnedDirectory, allowedDirectories
  }]])
}
```

Export `loadConfigSnapshot`, `startConfigReloader`, `authenticateBearer`, and `resolveScope`. Validate all fields before replacing the active snapshot. Never include tokens or Basic credentials in returned status objects.

- [ ] **Step 4: Integrate config/auth into the entrypoint without changing proxy semantics**

Keep route order: unauthenticated health, OPTIONS, bearer authentication, relay-owned routes, transparent proxy.

- [ ] **Step 5: Run proxy and config/auth tests**

Expected: all pass; malformed reload test proves the old valid config remains active.

- [ ] **Step 6: Review checkpoint**

Search test output/logs for token/password fragments. Do not commit.

### Task 3: Extract and harden the transparent proxy

**Files:**
- Create: `opencode-relay/lib/proxy.mjs`
- Modify: `opencode-relay/relay.mjs`
- Modify: `opencode-relay/test/proxy-compat.test.mjs`

- [ ] **Step 1: Add failing tests for stream-safe timeouts and revocation**

Assert ordinary requests retain the five-minute timeout, SSE streams are not destroyed by the ordinary request timer, and an active stream can be closed when its client token disappears from the reloaded configuration.

- [ ] **Step 2: Run tests and verify failure**

Expected: active SSE currently inherits generic timeout and revocation cannot address open streams.

- [ ] **Step 3: Implement `proxyRequest` as a focused module**

Export:

```js
export function proxyRequest({ clientReq, clientRes, target, scope, onOpen, onClose }) {}
```

Strip `authorization`, `host`, and `x-opencode-directory` before injecting canonical values. Track active requests by client ID so token reload can close streams. Apply the ordinary timeout only to non-SSE/non-sync requests.

- [ ] **Step 4: Run proxy tests**

Expected: legacy behavior remains byte-compatible and security tests pass.

- [ ] **Step 5: Review checkpoint**

Confirm unknown future OpenCode paths still forward without relay code changes. Do not commit.

### Task 4: Implement byte-safe SSE parsing and relay framing

**Files:**
- Create: `opencode-relay/lib/sse-codec.mjs`
- Create: `opencode-relay/test/sse-codec.test.mjs`

- [ ] **Step 1: Write failing parser tests**

Feed every possible split boundary across:

```text
: heartbeat\r\n\r\n
id: evt_1\n
event: sync\n
data: {"type":"sync"}\n
data: {"continued":true}\n\n
```

Also cover split UTF-8, CRLF/LF, comments, unnamed events, invalid JSON retained as raw data, maximum frame size, and clean EOF.

- [ ] **Step 2: Run tests and verify failure**

Expected: module missing.

- [ ] **Step 3: Implement incremental codec**

Export `SseDecoder` with `push(Buffer)` and `finish()`, preserving:

```js
{ id, event, dataLines, data, rawFrame }
```

Export encoders:

```js
encodeEvent({ id, event, data })
encodeComment('ping')
```

Reject over-limit frames without truncating and advancing sync state.

- [ ] **Step 4: Run codec tests**

Expected: all split-boundary cases pass and re-encoded data matches semantic source content.

- [ ] **Step 5: Review checkpoint**

Confirm parser never lets payload JSON overwrite the SSE event name. Do not commit.

### Task 5: Implement atomic sync metadata state and anchor validation

**Files:**
- Create: `opencode-relay/lib/sync-state.mjs`
- Create: `opencode-relay/test/sync-state.test.mjs`

- [ ] **Step 1: Write failing persistence tests**

Test state round-trip, stale temp files, malformed current state, atomic replacement, crash-before-rename, scope hashing, monotonic vector updates, event-ID anchors, and no event payload/content fields in the state file.

Expected state shape:

```json
{
  "schema": 1,
  "scopes": {
    "scope_hash": {
      "targetID": "home-opencode",
      "directoryHash": "sha256:...",
      "workspace": null,
      "generation": 1,
      "vector": {
        "ses_example": { "seq": 15, "eventID": "evt_last" }
      },
      "lastUpstreamAt": "2026-07-10T00:00:00.000Z",
      "lastResetReason": null
    }
  }
}
```

- [ ] **Step 2: Run tests and verify failure**

Expected: module missing.

- [ ] **Step 3: Implement serialized atomic writes**

Use one promise queue so writes cannot overlap. Write JSON to `<path>.tmp`, `FileHandle.sync()`, close, rename, and retain the last valid in-memory snapshot if reload fails. Export `loadSyncState`, `updateScopeFence`, `markScopeReset`, and `buildAnchorAuditVector`.

`buildAnchorAuditVector` maps each known `seq` to `Math.max(seq - 1, 0)` so the next history query must reproduce the stored event-ID anchor.

- [ ] **Step 4: Run state tests**

Expected: stale state can cause duplicate replay but never sequence advancement beyond a durably written anchor.

- [ ] **Step 5: Review checkpoint**

Open the state fixture and confirm no raw event `data` is persisted. Do not commit.

### Task 6: Implement the native OpenCode sync client

**Files:**
- Create: `opencode-relay/lib/opencode-sync-client.mjs`
- Create: `opencode-relay/test/opencode-sync-client.test.mjs`

- [ ] **Step 1: Write failing history/live client tests**

Against the fake upstream, assert:

- Basic authentication is always supplied;
- directory/workspace scope is canonical;
- history body is the exact vector object;
- omitted aggregates return full history;
- returned snake_case `aggregate_id` normalizes to `aggregateID` without losing the original event ID/type/data;
- live durable wrapper events normalize to the same shape as history events;
- reconnect uses bounded backoff and emits state transitions;
- 401 is authentication failure, not health/readiness.

- [ ] **Step 2: Run tests and verify failure**

Expected: module missing.

- [ ] **Step 3: Implement history and live APIs**

Export:

```js
createOpenCodeSyncClient({ target, scope })
  .history(vector, { signal })
  .events({ signal, onFrame })
  .health({ signal })
```

Use `POST /sync/history` with JSON body and `GET /global/event` or the verified scoped `/event` route. Preserve all unknown event types. Recognize durable wrappers only when they contain valid `syncEvent.id`, `aggregateID`, `seq`, `type`, and `data`.

- [ ] **Step 4: Run client tests**

Expected: history and live events share one normalized durable envelope.

- [ ] **Step 5: Review checkpoint**

Confirm no `/sync/replay`, `/sync/steal`, or mutation endpoint is invoked by relay recovery. Do not commit.

### Task 7: Implement subscribe-first history/live reconciliation

**Files:**
- Create: `opencode-relay/lib/sync-broker.mjs`
- Create: `opencode-relay/test/sync-broker.test.mjs`

- [ ] **Step 1: Write failing broker tests**

Cover:

1. live subscription registers before history query;
2. event created during history query is delivered once;
3. duplicate event ID from history/live is delivered once;
4. equal payload with distinct IDs is delivered twice;
5. sequence is monotonic within each aggregate;
6. tunnel disconnect emits disconnected, reconnects, anchor-audits, history-backfills, then emits reconnected;
7. relay restart uses persisted vector;
8. missing/mismatched anchor emits reset and increments scope generation;
9. volatile events pass live and dirty domains are reported after any upstream gap;
10. N clients share one upstream collector;
11. slow-client queue is bounded and only that client is reset.

- [ ] **Step 2: Run tests and verify failure**

Expected: broker missing.

- [ ] **Step 3: Implement the broker state machine**

States:

```text
STOPPED -> CONNECTING -> BACKFILLING -> LIVE
LIVE -> DISCONNECTED -> CONNECTING
any -> RESETTING -> BACKFILLING
```

Use maps keyed by `eventID` and `aggregateID`. Never deduplicate by payload hash. Advance a scope fence only after accepting the normalized durable event. Persist vector/anchor metadata asynchronously through the serialized state writer.

Broker public API:

```js
getOrCreateBroker(scope)
broker.subscribe({ clientID, knownVector, write, close })
broker.status()
broker.close()
```

- [ ] **Step 4: Run broker tests**

Expected: all race, reconnect, dedupe, reset, fanout, and backpressure cases pass under repeated runs.

- [ ] **Step 5: Stress the race tests**

Run:

```bash
for i in $(seq 1 50); do node --test test/sync-broker.test.mjs || exit 1; done
```

Expected: zero intermittent failures.

- [ ] **Step 6: Review checkpoint**

Verify exactness claims are limited to native durable events. Do not commit.

### Task 8: Expose `/relay/v1/sync/*` without changing legacy routes

**Files:**
- Create: `opencode-relay/lib/sync-protocol.mjs`
- Create: `opencode-relay/test/sync-protocol.test.mjs`
- Modify: `opencode-relay/relay.mjs`

- [ ] **Step 1: Write failing protocol tests**

Test authenticated:

```text
GET  /relay/v1/sync/capabilities
POST /relay/v1/sync/stream
GET  /relay/v1/sync/status
```

Cover invalid protocol/body/vector/seq, missing directory, disallowed scope, unknown target, malformed bearer, control frame order, SSE headers, heartbeat, cancellation, and legacy `/event` compatibility.

- [ ] **Step 2: Run tests and verify failure**

Expected: relay-owned routes currently proxy upstream or return 404.

- [ ] **Step 3: Implement strict request validation and streaming response**

Capabilities must advertise:

```json
{
  "protocol": 1,
  "mode": "opencode-native-history",
  "durableHistory": true,
  "liveStream": true,
  "delivery": "at-least-once",
  "ordering": "per-aggregate",
  "volatileRecovery": "snapshot"
}
```

Sync responses must set:

```js
{
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  'connection': 'keep-alive',
  'x-accel-buffering': 'no',
  'access-control-allow-origin': '*'
}
```

Ensure client disconnect removes only its subscription and does not stop a broker used by other clients.

- [ ] **Step 4: Run all relay tests**

Run `npm test` from `opencode-relay`.

Expected: all protocol and legacy compatibility tests pass.

- [ ] **Step 5: Review checkpoint**

Confirm the old mobile client can continue using legacy `/event` without recognizing relay frames. Do not commit.

### Task 9: Harden service lifecycle and reverse-proxy behavior

**Files:**
- Modify: `opencode-relay/opencode-relay.service`
- Modify: `opencode-relay/README.md`
- Modify after permission: `config/Caddyfile`
- Create: `opencode-relay/test/service-contract.test.mjs`

- [ ] **Step 1: Write service/config contract tests**

Parse the service and documentation as text. Assert matching `TOKENS_PATH`, `TOKEN_RELOAD_SEC`, `SYNC_STATE_PATH`, `StateDirectory`, `UMask`, memory limits, and no gzip/buffering on sync streams.

- [ ] **Step 2: Run tests and verify failure**

Expected: current service has no state directory and the README advertises generic compression/buffering.

- [ ] **Step 3: Update the service unit**

Add:

```ini
Environment=SYNC_STATE_PATH=/var/lib/opencode-relay/sync-state.json
StateDirectory=opencode-relay
StateDirectoryMode=0700
UMask=0077
```

Keep credentials in `/etc/opencode-relay`; keep metadata in `/var/lib/opencode-relay`. Add a bounded graceful shutdown that closes downstream streams, broker collectors, timers, and the HTTP server before exit.

- [ ] **Step 4: Update reverse-proxy documentation/config**

Document Caddy `flush_interval -1` or equivalent route-specific streaming and nginx:

```nginx
proxy_buffering off;
proxy_cache off;
gzip off;
proxy_read_timeout 3600s;
```

Do not deploy these changes yet.

- [ ] **Step 5: Run all tests**

Expected: service contract, protocol, broker, and proxy compatibility tests pass.

- [ ] **Step 6: Review checkpoint**

Inspect the diff for accidental secret or mobile-app changes. Do not commit.

### Task 10: Isolated semantic acceptance

**Files:**
- Create: `opencode-relay/test/exact-sync.e2e.test.mjs`
- Preserve evidence under: `.reports/opencode-relay-sync-results/`

- [ ] **Step 1: Test disconnected durable replay**

Establish vector `V`, disconnect the simulated client, create durable events, reconnect with `V`, apply events, and compare reconstructed session/message/part state to fake upstream authoritative state.

- [ ] **Step 2: Test history/live cut race**

Create events while history response is delayed. Expected: each upstream event ID appears once and no sequence is skipped within an aggregate.

- [ ] **Step 3: Test tunnel outage**

Disconnect the broker's upstream event socket while continuing to write native history events. Restore upstream. Expected: `relay.upstream.disconnected`, exact history backfill, dirty volatile domains, then `relay.upstream.reconnected`.

- [ ] **Step 4: Test relay restart**

Restart the isolated relay after persisting a vector. Expected: stale metadata may replay duplicates but authoritative reconstructed state remains equal and no event is omitted.

- [ ] **Step 5: Test backend reset**

Replace fake history with a new sequence space. Expected: anchor audit fails and `relay.reset` is emitted; no old cursor is accepted as continuation.

- [ ] **Step 6: Run with an isolated real OpenCode backend**

Use an alternate local port and throwaway directory/session. Repeat disconnected prompt, tunnel gap, relay restart, and idle backend restart. Compare final transcript tree to direct authenticated `GET /session/<id>/message` readback.

- [ ] **Step 7: Preserve redacted evidence**

Save requests, control frames, vectors, event IDs, semantic comparisons, process versions, and pass/fail. Never save Authorization headers or prompt bodies beyond the throwaway fixture text.

- [ ] **Step 8: Review checkpoint**

Do not deploy to VPS until isolated exact-sync acceptance passes.

### Task 11: Permission-gated VPS rollout

**Files:**
- Deploy only after approval: relay files, service unit, Caddy configuration.
- Do not modify app files.

- [ ] **Step 1: Produce a dry-run deployment manifest**

List exact local files, remote destinations, service-unit diff, state-directory creation, Caddy diff, rollback archive, and expected temporary remote impact. Surface current service/backend health.

- [ ] **Step 2: Request explicit deployment and lifecycle permission**

Wait for approval before uploading, restarting relay/Caddy, or rotating credentials.

- [ ] **Step 3: Deploy sync disabled**

Install code and state directory, restart relay under the existing transparent-proxy mode, and verify all legacy REST/SSE behavior through `opencode.example.com`.

- [ ] **Step 4: Enable sync for one test client/scope**

Verify capabilities, broker connection, history fence, heartbeat, and status without changing the mobile app.

- [ ] **Step 5: Execute live relay semantic acceptance**

Use a throwaway session. Disconnect the simulated remote client and FRP transport, complete a turn locally, restore transport, resume from prior vector, and compare reconstructed state with direct backend REST readback.

- [ ] **Step 6: Verify rollback**

Disable sync routes or restore the prior relay while keeping legacy proxy behavior available. State-vector metadata may remain; no conversation content should exist in it.

- [ ] **Step 7: Rotate credentials only after separate confirmation**

Coordinate local User-scope Basic password, VPS relay target credentials, and device bearer tokens. Verify authenticated local and public readback before invalidating old credentials.

- [ ] **Step 8: Stop before app work**

Summarize the accepted relay protocol and evidence. Update the app specification only in the next approved round; do not implement mobile code here.

## Plan self-review

- Spec coverage: native history, subscribe-first race closure, vectors/anchors, exact durable recovery, volatile refresh, relay restart, tunnel gap, backend reset, multiple clients, backpressure, privacy, legacy compatibility, service deployment, and app handoff all have tasks.
- Placeholder scan: no TBD/TODO/"implement later" placeholders remain.
- Type consistency: `clientID`, `targetID`, `scope`, `aggregateID`, `seq`, `eventID`, vectors, anchors, and protocol endpoints use consistent names.
- Exactness: no task claims exactly-once delivery or durable recovery for volatile state; final proof compares projected state with authoritative REST readback.
- Privacy: only vectors/anchors persist; event bodies are transient and native history remains authoritative.
- Repository/permission discipline: no commit or deployment occurs without explicit authorization; mobile app code is excluded.
