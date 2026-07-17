# OpenCode Relay State-Sync Design (Option D, rev 2)

**Date:** 2026-07-11 (rev 2, post three-reviewer integration)
**Status:** CANCELLED 2026-07-11 by user decision — the exact-sync relay lane was demolished in favor of the native pattern: deployed transparent proxy + client reconnect-and-refetch (server-authoritative state, TUI-attach semantics). The implementation described here was removed from `opencode-relay/`. This document is retained as design history only; do not resurrect without a new explicit user decision. The substrate findings (§1-2) remain valid and load-bearing for any future work: /sync/history is an unbounded global scan (OOM), and /api/session/:id/history is structurally empty for TUI sessions through v1.17.18.
**Supersedes:** §6 of `opencode-relay-server-design.md`; Option A of the 2026-07-11 handoff §8; rev 1 of this file
**Review basis:** three independent APPROVE-WITH-CHANGES verdicts (oracle / oracle-alpha / oracle-gamma, 2026-07-11); all gating findings integrated below

## 0. Revision log (rev 1 -> rev 2)

| Change | Source finding |
|---|---|
| Added per-client resume reconciliation (§3.4); broker reconcile alone was silent-omission for phone-side gaps | unanimous BLOCKER |
| Client anchors now per-session `{updated, incomplete}`; removed `known.watermark` entirely | alpha B-1, beta B-1/B-2 |
| Snapshot frames carry per-session `liveSeqCutoff`; client monotonic guard specified | unanimous MAJOR |
| Single v2 keyset census replaces legacy `?start=` watermark query, overlap knob, and `SYNC_RECONCILE_MAX_CHANGED` fallback | alpha M-6, beta M-5 |
| Census diff uses timestamp inequality (`!=`), not `>` | beta M-4 |
| Reset heuristics deleted; DB reset converges as ordinary census removals/additions/snapshots | beta M-4 |
| Active-set: seeded from snapshot content, re-derived after every reconcile, persisted | alpha M-2, beta B-2, gamma #7 |
| Streaming snapshot construction (one upstream page -> one chunk frame); no full-session buffering | unanimous MAJOR |
| Chunk contract: snapshotID + index + end marker + client atomic apply on end | alpha M-7, beta B-3, gamma #4 |
| Census atomicity: aborted/partial enumeration aborts the diff (no removals from truncated walks) | gamma #2 |
| `pageMessages` throws on non-positive limit; `history()` method deleted from the client lib | unanimous |
| `workspaceSupported: false` in protocol 2 | beta M-7 |
| `relay.live` = thin envelope, payload byte-preserved, seq exposed, strict scope filter | consensus |
| Dirty-domain -> REST endpoint mapping table added (§4.5) | alpha NIT-12 |

## 1. Dead architectures (unchanged from rev 1)

1. Native `/sync/history` bootstrap: unbounded global scan, real OOM (prior round evidence).
2. Handoff Option A `/api/session/:id/history`: v1/v2 event-namespace split makes it
   permanently empty for TUI sessions through at least `v1.17.18`; no bounded v1 read
   surface exists; core patch rejected. Evidence: `optionD-substrate-probes-20260711.md`.

## 2. Substrate facts

F1-F8 as recorded in `optionD-substrate-probes-20260711.md`. Load-bearing for this rev:

- v2 `GET /api/session?directory=&limit=&cursor=`: keyset pagination (`time_created`,`id`),
  items carry `time.updated` (epoch ms) and `location.directory` (probe-verified).
- Legacy `GET /session/:id/message?limit=&before=`: bounded newest-first pages,
  cursor `{id,time}`, `{info,parts}[]` complete per message; omitted/0 limit = unbounded dump.
- `session.time_updated` advances on turn admit / metadata / revert — NOT during streaming (F3/F4).
- Live `/global/event` v1 durable wrappers carry `(sessionID, seq)` per session (F6);
  `message.part.delta` is volatile (no durable seq).
- All surfaces share the relay's existing Basic auth.

## 3. Reconciliation model

### 3.1 Census

A **census** is one complete scoped enumeration: v2 keyset walk with explicit
`limit=100` pages and `directory` filter, yielding `{sessionID -> time.updated}`.

- A census is valid only if the walk completes. A failed/interrupted walk aborts the
  reconcile that requested it; **no removal may ever be derived from a partial census**.
- Ceiling `SYNC_CENSUS_MAX_SESSIONS` (default 5000): beyond it the reconcile fails
  explicitly (stream error frame + close; client retries later). Never truncate silently.
- Census results may be cached for `SYNC_CENSUS_TTL_MS` (default 3000) to serve
  concurrent client resumes without duplicate walks.

### 3.2 Broker state machine (upstream-facing)

```
STOPPED -> CONNECTING -> RECONCILING -> LIVE
LIVE -> DISCONNECTED -> CONNECTING          (upstream gap)
```

1. **Subscribe first**: open the upstream live event subscription; buffer frames.
2. **Reconcile (broker-relative)**: take a census; diff against the relay's persisted
   session index using timestamp **inequality**; changed/new sessions
   ∪ persisted active-set ∪ sessions seen in buffered live events => snapshot to all
   connected clients; index entries absent from census => `relay.session.removed`.
3. Update index/active-set/persistence; drain buffer through the seq guard (§3.6); LIVE.

A backend DB reset needs no special detection: the census diff converges the client
(mass removals + new sessions + snapshots). `relay.reset` remains only for
deterministic causes: scope identity change, protocol change, or operator action.

### 3.3 Active-set (closes F4)

A session is **active** when a turn may be in flight:

- live evidence: turn-start/step/message events without observed completion;
- snapshot evidence: a snapshot whose newest message is an incomplete assistant turn
  marks the session active; a snapshot whose newest state is settled clears it.

Rules: persisted with the scope state; re-derived from fresh readback after every
reconcile (completed-during-gap sessions leave the set — no unbounded accumulation);
conservatively inclusive on ambiguity. Active sessions are always included in every
reconcile's snapshot set (their `time_updated` is not trustworthy — F4).

### 3.4 Per-client resume reconciliation (the rev-1 gap)

Runs on **every** `POST /relay/v1/sync/stream`, independent of broker state:

```
input:  client.known = { sessions: { ses_example: { updated: <ms>, incomplete?: true } } }
census: fresh or TTL-cached (§3.1)
snapshot set  = { s in census : s not in known }                        (new to client)
             ∪ { s in census : census.updated != known[s].updated }     (changed, != not >)
             ∪ { s in census : known[s].incomplete }                    (client saw in-flight)
             ∪ activeSet ∩ census                                        (relay knows in-flight)
removed set   = { s in known : s not in census }
```

Frames: `relay.sync.begin` -> removals -> snapshots (streamed, §3.5) ->
`relay.sync.ready` carrying `{generation, censusCompletedAt, snapshotCount, dirtyDomains}`.
Fresh client (`known: {}`) => snapshot-all of the census.

Client persistence contract: applied session state and its per-session anchor
(`updated` from the snapshot's session info, `incomplete` derived from newest message
state) are persisted **atomically together**. Stale anchors cause redundant snapshots,
never omission. Request body capped at `SYNC_KNOWN_MAX_BYTES` (default 1 MiB) /
`SYNC_KNOWN_MAX_SESSIONS` (default 10000); over-cap => 413 + client falls back to `known: {}`.

While a downstream connection stays open, SSE ordering is the delivery guarantee;
any client-side doubt (queue overflow close, transport drop) funnels back into resume.

### 3.5 Snapshot construction (streaming, bounded)

For each session in a snapshot set, sequentially with concurrency
`SYNC_SNAPSHOT_CONCURRENCY` (default 2):

1. Record `liveSeqCutoff` = highest v1 durable seq observed/forwarded for that session
   so far (0 if none) **before** the first REST read.
2. `GET /api/session/{id}` for session info (also the scope-membership check).
3. Page legacy messages newest -> older with explicit positive `limit`
   (`SYNC_SNAPSHOT_PAGE_LIMIT`, default 100); **each upstream page is emitted
   immediately as one chunk frame and released** — the relay never materializes a
   full session in memory.
4. A 404 at any step => emit `relay.session.removed` for it instead (deleted mid-walk).

Per-page byte guard `SYNC_UPSTREAM_PAGE_MAX_BYTES` (default 8 MiB): an over-limit page
aborts that session's snapshot with an explicit stream error for that session
(`relay.session.error`, `reason:"page_over_limit"`) — never silent truncation.

### 3.6 Snapshot/live ordering guard

- Relay side: buffered/live v1 durable events for session S with `seq <= liveSeqCutoff(S)`
  of an in-flight or just-emitted snapshot are dropped for subscribers that received
  that snapshot.
- Client side: after applying a snapshot for S, ignore any `relay.live` durable event
  for S with `seq <= liveSeqCutoff` from that snapshot's `begin` frame.
- Volatile events (`message.part.delta`, status) carry no seq and never mutate durable
  projection — they are display overlay only, always safe to apply or drop.
- Live durable events for S arriving with `seq > cutoff` apply incrementally
  (v1 semantics: full-object upserts, idempotent by nature).

Known coupling: this leans on OpenCode's v1 event schema (wrappers with per-session
seq). Re-verify on every backend version bump — recorded as an operational rule.

## 4. Protocol 2 surface

Paths and bearer auth unchanged (`/relay/v1/sync/capabilities|stream|status`); all
legacy REST/SSE routes remain byte-transparent.

### 4.1 Capabilities

```json
{
  "protocol": 2,
  "mode": "opencode-session-state",
  "durableHistory": false,
  "liveStream": true,
  "scope": { "directoryRequired": true, "workspaceSupported": false },
  "delivery": "at-least-once",
  "ordering": "per-session",
  "recovery": "session-snapshot",
  "volatileRecovery": "snapshot"
}
```

### 4.2 Stream request

```json
POST /relay/v1/sync/stream?directory=<canonical-directory>
{ "protocol": 2, "known": { "sessions": { "ses_example": { "updated": 1783784006087 } } } }
```

### 4.3 Frames

```
event: relay.sync.begin
data: {"protocol":2,"scopeID":"...","generation":1,"mode":"opencode-session-state"}

event: relay.session.removed
data: {"sessionID":"ses_example"}

event: relay.snapshot.begin
data: {"snapshotID":"snp_...","sessionID":"ses_example","liveSeqCutoff":41,"session":{...}}

event: relay.snapshot.chunk
data: {"snapshotID":"snp_...","index":0,"messages":[{"info":...,"parts":[...]}]}

event: relay.snapshot.end
data: {"snapshotID":"snp_...","chunks":3,"newestMessageID":"msg_...","complete":true}

event: relay.session.error
data: {"sessionID":"ses_example","reason":"page_over_limit"}

event: relay.sync.ready
data: {"generation":1,"censusCompletedAt":1783784200000,"snapshotCount":4,
       "dirtyDomains":["status","permission","question","todo","diff"]}

event: relay.live
data: {"sourceType":"message.part.updated","sessionID":"ses_example","seq":57,"payload":{...}}

event: relay.upstream.disconnected / relay.upstream.reconnected
: ping
```

Chunk contract: chunks of one `snapshotID` are contiguous per session and indexed
monotonically from 0 (chunks of different sessions may interleave between snapshots,
never within one). Client buffers chunks and applies the session replacement
**atomically only on `relay.snapshot.end`** (chunk count must match); a stream drop
before `end` discards the partial buffer; resume re-requests via anchors.
Message order across chunks is newest -> older pages; each page internally oldest-first
(F2); the client orders by message ID/time after assembly.

`relay.live` payloads are byte-preserved v1 event bodies; the envelope adds only
`sourceType`, `sessionID`, `seq` (when durable). Events whose session is outside the
scope are dropped (membership = exact `location.directory` match, cached; unknown IDs
resolved via one bounded `GET /api/session/{id}` each, negative results cached).

### 4.4 Mutation window

Client disables mutations from `relay.sync.begin` until `relay.sync.ready`.
Trade-off (accepted for round 1): the window is scope-wide; large resumes briefly
block mutations even for already-applied sessions.

### 4.5 Dirty-domain refresh map

| Domain | Authoritative refresh |
|---|---|
| status | `GET /session/status` |
| permission | `GET /api/session/{id}/permission` |
| question | `GET /api/session/{id}/question` |
| todo | `GET /session/{id}/todo` |
| diff | `GET /session/{id}/diff` |

## 5. Persistence (VPS, non-sensitive)

```json
{
  "schema": 2,
  "scopes": {
    "<scope_hash>": {
      "generation": 1,
      "sessions": { "ses_example": 1783784006087 },
      "active": ["ses_example"],
      "lastCensusAt": 1783784200000,
      "lastUpstreamAt": "..."
    }
  }
}
```

Session IDs + epoch timestamps only; scope hashed; atomic replace unchanged.
Schema-1 files (seq vectors) are discarded on read => broker cold-starts with a fresh
census (correct, heavier). Missing file => same.

## 6. Exactness claims

Guaranteed: after `relay.sync.ready`, each snapshotted session's projected
session/message/part state equals authoritative REST readback **as of that session's
snapshot read** (per-session cut, not a global cut); in-flight turns spanning gaps are
recovered (client `incomplete` anchor + relay active-set + snapshot-content seeding —
three independent triggers); created/deleted sessions converge via census; delivery
at-least-once with idempotent snapshot replacement and seq-guarded live application.

Not claimed: per-event replay; cross-session ordering; a single global consistent cut;
volatile-domain recovery (dirty + REST refresh); continuation of turns interrupted by
backend death.

## 7. Component impact

| File | Change |
|---|---|
| `lib/opencode-sync-client.mjs` | Delete `history()`. Add `censusPages()` (v2 keyset), `getSession()`, `pageMessages()` (throws unless `limit > 0`), keep health + live subscription. Per-page byte guard. |
| `lib/sync-broker.mjs` | Replace vector reconciliation with §3.2-§3.6: census diff, active-set lifecycle, per-client resume, streaming snapshots, seq cutoff guard. Keep collector sharing, bounded client queues, backpressure closes. |
| `lib/sync-state.mjs` | Schema 2 (§5); schema-1 discard-on-read. |
| `lib/sync-protocol.mjs` | Protocol 2 validation, frames, caps (§4); request body caps. |
| `test/helpers/fake-upstream.mjs` | Add v2 keyset census, `/api/session/{id}`, legacy message pager with cursor; model `time_updated` semantics **including F4** (touch-only bump; streaming does not bump); deletable sessions; live v1 wrappers with per-session seq. |
| `relay.mjs`, `lib/{config,auth,proxy,sse-codec,directory-path}.mjs` | Unchanged. |
| `opencode-relay.service`, `README.md` | Env/name/text updates only. |

New env knobs: `SYNC_CENSUS_MAX_SESSIONS=5000`, `SYNC_CENSUS_TTL_MS=3000`,
`SYNC_SNAPSHOT_PAGE_LIMIT=100`, `SYNC_SNAPSHOT_CONCURRENCY=2`,
`SYNC_UPSTREAM_PAGE_MAX_BYTES=8388608`, `SYNC_KNOWN_MAX_BYTES=1048576`,
`SYNC_KNOWN_MAX_SESSIONS=10000`. Existing buffer/queue/heartbeat/reconnect knobs stay.

## 8. Semantic acceptance

Fake-upstream (must model F4 or the acceptance is theater):
1. Client resume against an already-LIVE broker (phone-side gap only) recovers changed
   sessions — **the rev-1 blocker case**.
2. Gap spanning an in-flight turn (admitted pre-gap, streamed mid-gap, `time_updated`
   stale) — recovered via each of the three triggers independently (disable the other two per variant).
3. Turn admitted during gap-1, still streaming, gap-2 before any live frame => recovered
   after gap-2 (snapshot-content seeding case).
4. New session mid-gap discovered; deleted mid-gap removed; deleted mid-snapshot-walk
   handled via 404 => removed.
5. Partial census (interrupted walk) => reconcile aborts; no removal emitted.
6. Snapshot/live race: buffered stale event (seq <= cutoff) never regresses applied
   snapshot; newer event (seq > cutoff) applies exactly once.
7. Chunked snapshot: multi-page session assembles atomically; drop before `end` leaves
   client state untouched; re-resume converges.
8. Relay restart: schema-2 state resumes; schema-1/missing state => census cold-start;
   duplicates allowed, omission never.
9. Timestamp regression (restored-from-backup fake) => `!=` diff re-snapshots; client
   converges without any reset machinery.
10. Slow client / multi-client isolation / token revocation / transparent-proxy
    compatibility suites stay green.
11. `pageMessages` without positive limit throws (unit).

Real-backend E2E (isolated alternate-port backend, throwaway directory):
per rev 1 §8, plus the phone-side-gap-only scenario (relay upstream never drops) and
final semantic tree equality against direct authenticated REST readback; repeat after
relay restart and idle backend restart; verify state/logs contain no content/credentials.

Deployment (Task 11) remains permission-gated and outside this round.
