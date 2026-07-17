# OpenCode persistent backend and exact-sync relay handoff

Date: 2026-07-11  
Status: **STOPPED BY USER — no further implementation or deployment**

## 1. Overall construction

This work has three layers:

1. **Windows persistent OpenCode backend**
   - Keep one authenticated OpenCode `serve` process on `127.0.0.1:4096`.
   - Make ordinary `opencode` invocations attach to that backend with the correct directory/session arguments.
   - Preserve explicit local bypass and controller lifecycle commands.
   - Keep the FRP/SSH transport lifecycle independent from the backend lifecycle.

2. **opencode-vps relay exact incremental synchronization**
   - Preserve the existing bearer-to-Basic transparent REST/SSE proxy.
   - Add authenticated `/relay/v1/sync/*` protocol surfaces.
   - Reconcile durable events subscribe-first, deduplicate by upstream event ID and per-session sequence, and persist only non-sensitive anchors.
   - Keep transcript bodies in the Windows OpenCode database rather than on the VPS.

3. **Permission-gated VPS rollout**
   - Produce a deployment manifest and rollback path.
   - Deploy relay/systemd/Caddy changes only after explicit permission.
   - Verify legacy proxy behavior before enabling sync for one test client.

Primary design and plans:

- `.reports/opencode-relay-server-design.md`
- `.reports/opencode-relay-server-windows-plan.md`
- `.reports/opencode-relay-exact-sync-plan.md`

## 2. Current completion map

| Workstream | Status | Meaning |
|---|---|---|
| Windows Tasks 1–8 | Complete | Controller, launcher, attach behavior, tests, and live-port semantic acceptance passed. |
| Windows Task 9 | Complete and locally cut over | Production `opencode.cmd` uses the controller/launcher chain; old restart TUI action was removed. |
| Exact-sync Tasks 1–9 | Implemented locally; unit-tested | Relay modules, protocol, broker, state, service hardening, and documentation exist. They are not deployable as currently designed because Task 10 invalidated the history-bootstrap assumption. |
| Exact-sync Task 10 fake E2E | Pass, but insufficient | Fake upstream scenarios pass; the fixture did not model the real global unbounded history query. |
| Exact-sync Task 10 real E2E | Blocked by architecture | Real `/sync/history {}` produced an out-of-memory response. No semantic acceptance was claimed. |
| Exact-sync Task 11 | Not started | Nothing from this exact-sync round was deployed to the VPS, systemd, or Caddy. |
| Mobile application work | Out of scope | No mobile implementation should be attributed to this round. Existing untracked mobile files predate or are separate from this track. |

## 3. Completed Windows backend work

Production files:

- `C:\Users\example\.config\opencode\bin\opencode-relay-common.psm1`
- `C:\Users\example\.config\opencode\bin\opencode-relay-server.ps1`
- `C:\Users\example\.config\opencode\bin\opencode-launch.ps1`
- `C:\Users\example\.config\opencode\bin\opencode-daemon-launcher.mjs`
- `C:\Users\example\.config\opencode\bin\opencode.cmd`

Implemented behavior:

- `opencode --relay_server start|status|doctor|restart|stop`
- separate `restart tunnel` behavior
- bare interactive attach with explicit directory forwarding
- `-s`, `--session`, `--continue`, `--fork`, and `--mini` interactive routing
- `--local` bypass
- authenticated health/config probes
- exact listener/PID/executable/start-time verification
- PID-reuse defense, generation state, lifecycle mutex, and managed attach leases
- Ctrl+D detaches a TUI without stopping the backend
- disruptive restart closes managed TUIs, advances generation once, and leaves transport untouched

The persistent spawn primitive is the Tiny Node launcher. It uses direct detached `spawn`, file-backed stdout/stderr, `shell:false`, and exits immediately after a bounded handshake. Product code does not depend on WMI.

Important operational constraint:

- **Never use `Start-Process` inside an OpenCode Bash tool call to launch a long-lived process.** The harness may wait on descendants indefinitely even after output redirection. For automated test orchestration on this machine, use an external WMI/CIM broker or the existing controller/daemon surface, then check status and health in separate bounded commands.

The project memory file `D:\workspace\.opencode\memory\10-example-localhost-runtime-loops.md` still contains the old contradictory `Start-Process` recommendation. A semantic-replacement diff was proposed but not applied because explicit confirmation was not received.

## 4. Current Windows runtime readback

Read back immediately before this handoff:

- Backend state: healthy
- OpenCode version: `1.17.14`
- Backend/listener PID: `48752`
- Command: `opencode.exe serve --hostname 127.0.0.1 --port 4096`
- Controller generation: `2`
- FRP-related PIDs still alive: `73844`, `37672`
- No Task 10 isolated relay remains running
- Task 10 temporary bearer/Basic credential files were deleted

Canonical final state snapshot:

- `.reports/opencode-controller-tests/results/task8-4096-20260711-node/task9-final-state-snapshot.json`

Do not assume these PIDs remain current in a later session; repeat the identity/health checks below.

## 5. Windows semantic acceptance already completed

Acceptance evidence:

- `.reports/opencode-controller-tests/results/task8-4096-20260711-node/acceptance-summary.md`
- `.reports/opencode-controller-tests/results/task8-4096-20260711-node/canonical-state-snapshot.json`
- `.reports/opencode-controller-tests/results/task8-4096-20260711-node/task9-final-state-snapshot.json`
- controller/backend stdout and stderr logs in the same directory
- pre-cutover backups of `opencode.cmd`, `tui.jsonc`, and the retired restart plugin in the same directory

Verified behavior includes:

- Tiny Node launcher returned EOF while its direct child remained the sole listener.
- The controller harness passed twice consecutively and cleaned its processes.
- Real authenticated backend health/config passed on 4096.
- Two-directory managed attaches passed.
- Ctrl+D detach preserved backend PID/generation.
- `-s` resumed the exact disposable session.
- Tunnel-only restart did not change backend PID/generation.
- Production cutover restarted the managed backend exactly once, from generation 1 to 2.
- FRP process creation times remained unchanged through backend restart.
- The old `Restart OpenCode Server` command disappeared from a fresh TUI.
- `plugins/opencode-restart/tui.mjs` and its `tui.jsonc` registration were removed. The plugin directory still contains `package.json`; do not treat that file alone as an active plugin.

## 6. Exact-sync relay implementation completed locally

Root: `D:\workspace\project\opencode-relay`

Key files and inspection purpose:

- `relay.mjs` — route ordering, config reload, broker lifecycle, graceful shutdown
- `lib/config.mjs` — v1 migration and v2 target/client validation
- `lib/auth.mjs` — timing-safe bearer authentication and scope resolution
- `lib/directory-path.mjs` — canonical POSIX and Windows absolute-path validation
- `lib/proxy.mjs` — transparent request/response/SSE proxy behavior
- `lib/sse-codec.mjs` — byte-safe incremental SSE decode/encode
- `lib/opencode-sync-client.mjs` — current upstream health/history/global-event client
- `lib/sync-state.mjs` — atomic non-sensitive sequence/event-ID anchors
- `lib/sync-broker.mjs` — subscribe-first reconciliation, dedupe, reconnect, dirty/reset frames, shared collectors, bounded client queues
- `lib/sync-protocol.mjs` — `/relay/v1/sync/capabilities|status|stream`
- `opencode-relay.service` — systemd state/credential separation and memory/shutdown limits
- `README.md` — deployment and reverse-proxy streaming notes
- `test/*.test.mjs` — unit, compatibility, broker, protocol, service-contract, and fake E2E coverage

Latest full local result:

```text
npm test
tests 68
pass 68
fail 0
```

The latest two tests and implementation change added support for canonical Windows backend directories. This was discovered only when the real relay loaded a pinned `D:\...` scope; the previous POSIX-only validator silently loaded an empty configuration and rejected the bearer token.

## 7. Task 10 finding that invalidates the current sync bootstrap

Canonical investigation:

- `.reports/opencode-relay-sync-results/task10-native-history-investigation.md`
- `.reports/opencode-relay-sync-results/live-example/direct-history-response.txt`

Real behavior:

```json
{"name":"BadRequest","data":{"message":"RangeError: Out of memory","kind":"Body"}}
```

The request was authenticated `POST /sync/history` with body `{}` against the real shared OpenCode database. It failed after approximately 22 seconds. The backend remained healthy afterward.

Two independent source audits of OpenCode `v1.17.14` commit `<upstream-commit>` agreed:

- `/sync/history` queries the global `event` table.
- directory/workspace routing does not add a row-level history filter.
- an empty vector results in no WHERE clause and no LIMIT, followed by `.all()` materialization.
- aggregate IDs omitted from a non-empty vector return complete history, so supplying only this project's sessions is still unsafe.
- `/sync/start`, `/sync/replay`, and `/sync/steal` do not provide a bounded read bootstrap.
- safe bounded existing surfaces are scoped/paginated `/api/session`, per-session `/api/session/:id/history`, and per-session event tails.

Primary source:

- `https://github.com/anomalyco/opencode/blob/<upstream-commit>/packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts#L71-L84`

Consequences:

- Do not call `/sync/history {}` again against the shared production DB.
- Do not deploy the current `opencode-sync-client.mjs`/broker bootstrap as exact sync.
- `fake-e2e-summary.json` proves the relay algorithm against the fake contract only; it does not prove production viability.
- `direct-history-before.json` was written after a timed-out/failed attempt and must not be interpreted as a successful empty-history readback.
- Current capabilities advertise `mode: opencode-native-history`; that remains unaccepted while the unsafe bootstrap is present.

One throwaway OpenCode session created during the real probe may remain in the local database:

- `ses_example`

It is intentionally documented rather than deleted during stop-work closeout.

## 8. Architecture decision required before resuming

### Option A — existing bounded session APIs (recommended)

- subscribe before reconciliation;
- enumerate sessions by canonical directory or project;
- page each session's durable history;
- buffer/deduplicate live events;
- re-enumerate sessions after every gap to discover sessions created while disconnected;
- preserve per-session sequence/event-ID anchors;
- use authoritative snapshots for non-session volatile domains.

This avoids an OpenCode core patch and global history scans, but requires changing the relay upstream client/broker and explicitly narrowing the protocol claim to supported session durable events.

### Option B — add an allowlisted/paginated native sync endpoint

Patch OpenCode history to accept an explicit aggregate allowlist plus cursor/limit, reusing internal `readAggregate`/fence primitives. This preserves the original relay design more closely but creates an upstream core patch to maintain.

### Option C — isolated database per workspace

Keep existing `/sync/history` semantics but target physically isolated workspace databases. This conflicts with the current shared persistent 4096 backend architecture and is not recommended.

No option was approved before stop-work. Do not implement based on assumption.

## 9. Revised Task 10 acceptance if Option A is chosen

1. Start the live stream before scoped reconciliation.
2. Enumerate a throwaway directory's sessions and page every session history to completion.
3. Update an existing throwaway session during a relay gap and recover it exactly.
4. Create a new session during the gap and prove re-enumeration discovers it.
5. Restart the relay with persisted anchors and prove duplicate-free continuation.
6. Restart the backend and prove the same session/message projection after recovery.
7. Compare relay reconstruction with direct authenticated session/message REST readback.
8. Verify relay state/logs contain no transcript bodies, prompts, Authorization headers, bearer tokens, or Basic passwords.
9. Run an independent behavioral review before any deployment claim.

## 10. Where to inspect earlier work

Recommended order:

1. Read `.reports/opencode-relay-server-design.md` for the intended topology and boundaries.
2. Read `.reports/opencode-relay-server-windows-plan.md`, then compare production files under `C:\Users\example\.config\opencode\bin` with the Task 8/9 evidence.
3. Read `.reports/opencode-controller-tests/results/task8-4096-20260711-node/acceptance-summary.md` and both final state snapshots.
4. Read `.reports/opencode-relay-exact-sync-plan.md` Tasks 1–9, then inspect the corresponding `opencode-relay/lib` and test files listed above.
5. Run `npm test` from `opencode-relay`.
6. Read `.reports/opencode-relay-sync-results/task10-native-history-investigation.md` and the raw 400 response before trusting any fake E2E result.
7. Decide Option A or B and update the design/plan before modifying relay code.
8. Only after revised isolated semantic acceptance passes should Task 11 produce a VPS dry-run manifest and request deployment permission.

## 11. Safe readback commands

Backend controller:

```powershell
opencode --relay_server status --json
opencode --relay_server doctor --json
```

Listener/process identity:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 4096
Get-CimInstance Win32_Process -Filter "ProcessId=48752"
```

Relay tests:

```powershell
cd D:\workspace\project\opencode-relay
npm test
```

Repository state:

```powershell
cd D:\workspace\project
git status --short
git diff -- config/Caddyfile
```

Do not print User-scope `OPENCODE_SERVER_PASSWORD`, bearer tokens, `opencode-relay/tokens.json`, or `.reports/opencode-secrets.env` during readback.

## 12. Repository and deployment state

- Branch: `main`
- No commit was created for this round.
- `opencode-relay/` is currently untracked.
- `config/Caddyfile` is modified locally with the existing `opencode.example.com` reverse-proxy block; this is not evidence that the VPS was updated.
- Several mobile/docs/scripts paths are also untracked or modified. Do not stage them as part of this relay track without first determining ownership.
- `opencode-relay/tokens.json` may contain credentials. Never commit or print it.
- Task 11 did not upload, restart, rotate, or deploy anything remotely.

## 13. Stop-work state

- Auto-continue is disabled.
- Task 10 implementation/acceptance is cancelled pending a future architecture decision.
- Task 11 deployment is cancelled and remains permission-gated.
- No isolated Task 10 relay process or temporary credential artifact remains.
- Production backend 4096 and the pre-existing transport processes were left running and healthy.
