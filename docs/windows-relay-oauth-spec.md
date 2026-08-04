# Windows OpenCode Relay OAuth Product Specification

**Status:** normative handoff for the Windows implementation agent  
**Date:** 2026-07-14  
**Server contract:** already deployed at `https://opencode.example.com`  
**Reference implementation:** `scripts/macos-relay/` plus `opencode-relay/`

This document specifies product behavior, not a suggested script. The Windows agent may
choose CMD, PowerShell 7.2+, Node, scheduled tasks, or another implementation internally,
but every observable contract and acceptance case below is mandatory.

## 1. User-facing outcome

There is exactly one shared OpenCode backend on `127.0.0.1:4096` per Windows machine.

- Bare interactive `opencode` from any terminal and any directory attaches a TUI to that
  backend with the invoking directory. It never starts an independent fallback process.
- If the managed backend is absent and port 4096 is free, bare `opencode` starts it first,
  waits for authenticated readiness, and then attaches.
- `opencode --local ...` is the unconditional escape hatch. The outer CMD strips only
  `--local` and invokes the untouched real OpenCode command with every remaining argument.
  It performs zero module imports, probes, state reads, OAuth calls, serve/attach decisions,
  or credential injection.
- `opencode --relay_server ...` manages the shared backend and its VPS connection.
- Normal VPS onboarding is browser-authorized. The user never types a Bearer token, FRP
  token, Basic password, host, or port.

The canonical flag is `--relay_server`. Do not introduce a second spelling.

## 2. Required command surface

```text
opencode --relay_server start [--json]
opencode --relay_server status [--json]
opencode --relay_server restart [--json]
opencode --relay_server stop [--json]
opencode --relay_server doctor [--json]
opencode --relay_server rename "<machine name>" [--json]

opencode --relay_server start tunnel [--json]
opencode --relay_server restart tunnel [--json]
opencode --relay_server stop tunnel [--json]
opencode --relay_server status tunnel [--json]
```

An internal `backend` target may be implemented for the bare launcher. It must start or
inspect only the local 4096 backend and must never wait for browser authorization. It does
not need to be advertised to users.

## 3. Separate persistent authorization from runtime state

These states must never be conflated.

### 3.1 Persistent machine authorization

The OAuth result contains a stable installation ID, machine ID, target ID, machine bearer,
transport assignment, and FRP transport credential. Store it in a user-only file/credential
store. It survives `start`, `restart`, `stop`, terminal closure, logoff, reboot, and OpenCode
updates.

Only these events may replace it:

1. the owner revokes the machine in the Dashboard;
2. the relay returns `401 invalid_machine_token`;
3. the user runs a future, explicit reset/re-pair command.

`stop` and `restart` must not delete or rotate authorization.

### 3.2 Runtime components

Track each component independently with PID plus creation time/executable identity:

1. backend: `opencode serve --hostname 127.0.0.1 --port 4096`;
2. SSH local forward to the VPS FRP server;
3. `frpc` for the assigned target/remote port;
4. heartbeat agent.

Never identify ownership by process name alone. Never run broad commands such as killing all
`opencode`, `ssh`, `frpc`, `node`, or `pwsh` processes.

## 4. Lifecycle state machine

The aggregate states are `Ready`, `Stopped`, `Degraded`, `Conflict`, and `Error`.

| Command and initial state | Required result |
|---|---|
| `start` while fully `Ready` | Return success without changing backend generation/PID, SSH PID, FRPC PID, agent PID, machine ID, target, or credential. Do not open a browser. |
| `start` while partially degraded | Converge only missing/unhealthy owned components toward `Ready`. Do not restart a healthy backend merely because the tunnel or agent is down. |
| `start` while stopped, credential valid | Start backend, tunnel, and heartbeat. Reuse credential; do not open a browser. |
| `start` while credential missing/revoked | Run OAuth device authorization once, then start/repair runtime components after approval. |
| `start` while foreign listener owns 4096 | Fail closed with `Conflict`; never kill, adopt, or replace it. |
| `restart` while `Ready` | Validate/reuse authorization, gracefully exit attached TUIs, restart backend exactly once, restart tunnel, restart heartbeat, and return only after aggregate readiness. |
| `restart` while stopped | Behave as a convergent start, but retain the same machine authorization. |
| `restart` with a partial failure | Preserve any component that did start, report `Degraded`, and return nonzero. Never claim rollback or success that did not occur. |
| `stop` while running | Send final lifecycle heartbeat, stop heartbeat, stop FRPC/SSH, gracefully close attached TUIs, then stop the owned backend. Preserve authorization. |
| `stop` while already stopped | Return success without changing credentials or generation. |
| `stop` with a stubborn component | Attempt every component, inspect final state, return `Degraded`/nonzero if anything remains. Never print `Stopped`. |
| `status` / `doctor` | Read-only. Never start, stop, authorize, rotate, or repair anything. |
| `rename "<name>"` | Update the canonical relay machine name without changing runtime processes, machine/target IDs, ports, or credentials. Persist the returned identity locally. |

All lifecycle mutations must serialize through one bounded machine-wide mutex. Concurrent
`start` calls collapse into one start; `start` racing `restart` or `stop` must have a single,
deterministic winner.

## 5. Exact semantics of each command

### 5.1 `start`: idempotent ensure

`start` means **ensure desired state**, not **restart everything**.

1. Load the user-scope local Basic credential and protected machine credential.
2. If a machine credential exists, call `GET /api/machine/me`.
   - `200`: reuse it.
   - `401`: mark it revoked and begin device authorization.
   - network/5xx: fail with `Degraded`; do not discard a possibly valid credential.
3. If no valid credential exists, execute the OAuth flow in section 7.
4. Ensure the owned 4096 backend. A healthy owned backend is a no-op.
5. Ensure SSH and FRPC. Healthy identity-matched processes are no-ops.
6. Ensure the heartbeat agent. A healthy identity-matched agent is a no-op.
7. Probe authenticated local `/global/health` and `/config`, then rely on the VPS heartbeat
   response and target health. Return `Ready` only when all required checks pass.

Calling `start` ten times on a healthy system must be observationally equivalent to calling
it once.

### 5.2 `restart`: intentional runtime replacement

`restart` preserves authorization but intentionally creates a new runtime generation.

1. Validate the machine credential as `start` does. Do not reauthorize a valid machine.
2. Publish `lifecycle=stopping`.
3. Request attached TUIs to exit and abort only still-busy sessions according to the existing
   controller contract. Session data itself must not be deleted.
4. Verify backend identity again immediately before termination; stop only that process tree.
5. Wait for port 4096 to become free with a bounded deadline.
6. Start one replacement backend and wait for authenticated health/config readiness.
7. Restart only the owned SSH/FRPC processes, preserving the assigned target and port.
8. Restart the heartbeat agent and wait for one accepted `lifecycle=running` heartbeat.
9. Return `Ready`. Any incomplete stage returns `Degraded`/nonzero with component detail.

Generation increments exactly once when a backend is actually replaced. If restart begins
from a stopped state, the new backend still advances from the last recorded generation.

### 5.3 `stop`: convergent stop, authorization retained

1. Stop does not require network availability or a valid OAuth credential.
2. The agent sends a final heartbeat with `lifecycle=stopped` and then exits. If the network
   is unavailable, continue local stop and record that warning.
3. Stop identity-matched FRPC and SSH processes.
4. Gracefully close attach clients, then stop the identity-matched backend.
5. Inspect the actual listener and every recorded process identity.
6. Return success only when backend, tunnel, and agent are all stopped.
7. Keep the machine credential, FRP assignment, installation ID, target ID, generation, logs,
   and non-secret diagnostics so the next start is silent and deterministic.

Dashboard state becomes `stopped`, not `revoked`. A subsequent start changes it back to
`online` without passkey interaction.

## 6. Bare `opencode` and `--local`

The outer CMD must dispatch on the exact first argument before any other work.

### `opencode --local [arguments...]`

1. Resolve the real npm/binary OpenCode path. It must not resolve back to the wrapper.
2. Strip `--local` only.
3. Remove `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` from the child environment.
4. Invoke the real CLI with all remaining arguments and propagate its exit code.

### Bare/interactive `opencode`

Interactive first forms are empty args, `--dir`, `--continue`, `-c`, `--session`, `-s`,
`--fork`, and `--mini`.

1. Probe authenticated local health/config on 4096.
2. If absent and the port is free, call the internal backend-only start and probe again.
3. If a foreign listener exists, fail closed with a useful ownership error.
4. If the managed backend is not ready, exit nonzero. Do **not** start an independent local
   fallback; `--local` is the explicit escape hatch.
5. Start `opencode attach http://127.0.0.1:4096 --dir <invoking-directory> ...`.
6. Inject Basic credentials into this attach child via environment only.
7. Register a generation-bound attach lease and remove it on exit.

Noninteractive native commands such as `models`, `serve`, `export`, and `--version` pass to
the real CLI unchanged unless a separately documented product command owns them.

## 7. OAuth device authorization contract

No QR code is used for machine onboarding.

1. `POST /api/oauth/device/code` over TLS with installation ID, display name, hostname,
   platform=`windows`, client version, local Basic username/password, and existing requested
   target/remote port when migrating `primary-opencode`.
2. Receive `device_code`, `user_code`, `verification_uri_complete`, `expires_in`, `interval`.
3. Open `verification_uri_complete` in the user's normal browser and print the same URL/code.
4. Poll `POST /api/oauth/token` no faster than `interval`.
5. Handle `authorization_pending`, `slow_down`, `access_denied`, and `expired_token` exactly.
6. Atomically store the one-time response with user-only ACL. Never log tokens or put them in
   process arguments.
7. On later start/restart, validate the long-lived bearer with `/api/machine/me` instead of
   opening the browser.

The relay stores only the machine bearer hash. Dashboard revoke invalidates the bearer and
removes the managed target from discovery immediately.

## 8. Heartbeat and Dashboard contract

POST `/api/machine/heartbeat` with the machine bearer every 30 seconds and immediately after
start/restart. Payload:

```json
{
  "lifecycle": "running",
  "localHealth": true,
  "opencodeVersion": "1.17.18",
  "controllerVersion": "2",
  "lastError": null
}
```

Valid lifecycle values are `running`, `stopping`, and `stopped`. The VPS independently probes
the assigned target; the client cannot declare itself publicly reachable.

Dashboard states:

- `online`: fresh running heartbeat, local health true, VPS probe succeeds;
- `degraded`: only part of the above is true;
- `offline`: no fresh heartbeat and VPS probe fails;
- `stopped`: explicit final stopped heartbeat;
- `revoked`: owner revoked the credential.

### 8.1 Bidirectional display-name synchronization

Machine names are canonical relay identity data, not Dashboard-only labels and not hardcoded
hostnames. The same `displayName`, `displayNameRevision`, and `displayNameUpdatedAt` values must
be shown by the Dashboard, `/relay/targets`, the local status output, and the protected local
machine credential.

- A Dashboard rename calls `POST /api/machine/rename` with the passkey web session and
  `{ "machineID": "...", "displayName": "..." }`.
- A machine-side rename calls `POST /api/machine/name` with its machine bearer and
  `{ "displayName": "..." }`.
- `GET /api/machine/me`, the successful OAuth token response, and every accepted
  `POST /api/machine/heartbeat` response return the current canonical `machine` object.
- The Windows client atomically merges that returned `machine` object into its protected
  credential after every successful `me`, rename, OAuth, or heartbeat call. It must not replace
  the access token or transport assignment while doing so.
- Explicit renames are last-write-wins at the relay and increment `displayNameRevision`.
  A stale heartbeat never uploads a name and therefore can never undo a Dashboard rename.
- `displayName` is the sole canonical label. When loading legacy state where
  `displayTargetName` differs or revision metadata is absent, the relay normalizes the
  discovery label and revision metadata from `displayName` and atomically persists the
  migrated state before serving discovery.
- Renaming changes relay discovery labels immediately but preserves installation ID, machine ID,
  target ID, remote port, bearer token, FRP token, process identities, and backend generation.
- Names are trimmed, control characters are removed, empty names are rejected, and the maximum
  stored length is 80 characters.

## 9. JSON and exit-code contract

`--json` emits exactly one compact object on stdout and no secrets. Human diagnostics go to
stderr. Minimum aggregate shape:

```json
{
  "State": "Ready",
  "Backend": { "Status": "Managed", "PID": 123, "Generation": 8, "Port": 4096 },
  "Tunnel": { "Status": "Running", "SSHPID": 124, "FRPCPID": 125 },
  "HeartbeatAgent": { "Status": "Running", "PID": 126, "LastAcceptedAt": "..." },
  "MachineAuthorization": { "Status": "Authorized", "MachineID": "...", "TargetID": "primary-opencode" },
  "Warnings": []
}
```

Exit codes:

- `0`: requested mutation achieved its target, or status is `Ready`;
- `3`: read-only status reports `Stopped`;
- `6`: ownership conflict, stale identity requiring intervention, revoked/denied authorization;
- `7`: unhealthy/degraded component, timeout, or relay/network unavailability;
- `10`: invalid arguments/configuration or internal contract failure.

Successful `stop` returns 0, including repeated stop. It must not reuse status code 3 for the
mutation itself.

## 10. Security and durability invariants

- Basic credentials and OAuth/FRP tokens never appear in argv, stdout, JSON status, logs, or
  Dashboard payloads.
- Persistent files use atomic temp-write + replace and a user-only ACL.
- Validate PID, creation time, executable path, parent/group identity as applicable before
  every destructive action. Revalidate immediately before kill.
- A recycled PID is foreign; never kill it.
- Bounded mutex, readiness, port-free, client-exit, and process-stop deadlines are mandatory.
- A valid state/config update is all-or-nothing. Retain the last known-good state after a
  malformed write or interrupted process.
- Do not expose FRPS directly to the internet; keep the existing SSH local-forward transport.
- Do not modify the VPS `primary-opencode` static behavior until the OAuth-approved machine has
  successfully claimed that same target and passed regression tests.

## 11. Mandatory acceptance matrix

The Windows agent must automate these tests and provide captured evidence. A green unit test
without the matching live check is insufficient.

1. **Escape hatch:** `opencode --local` with zero args and with multiple/quoted args reaches
   the real CLI exactly once; no probe/controller/module is touched and no server credential is
   present in the child.
2. **Cold bare launch:** with port 4096 free, bare `opencode` starts exactly one server, waits
   for health/config, and attaches from the invoking directory.
3. **Two directories:** two concurrent bare invocations in different directories share the
   same listener PID and create two correct attach leases.
4. **Repeated start:** capture backend generation/PID, SSH PID, FRPC PID, agent PID, machine ID,
   target ID, and credential hash; run start at least three times; every captured value is
   unchanged and no browser opens.
5. **Repair start:** kill only FRPC, then start; backend generation/PID stays unchanged while a
   new owned FRPC process becomes healthy. Repeat for the heartbeat agent.
6. **Restart:** with attach clients present, restart exits those TUIs, advances backend
   generation exactly once, changes all intended runtime PIDs, preserves machine/target/token,
   and returns to Dashboard `online` with sessions still present.
7. **Stop:** stop removes the listener and all owned runtime processes, Dashboard becomes
   `stopped`, credential remains, and a second stop returns 0 without mutation.
8. **Start after stop:** returns to `online` without opening a browser or changing machine ID,
   target ID, or credential.
9. **Stubborn component:** simulate an unkillable/identity-drifted agent or tunnel. Stop attempts
   every component but returns 7/`Degraded`, never `Stopped`, and never kills the foreign PID.
10. **Foreign 4096:** place an unrelated listener on 4096. Start/restart/stop fail closed and
    leave its bytes, PID, and start time unchanged.
11. **Revocation:** revoke from Dashboard; proxy access immediately fails, active streams close,
    heartbeat receives 401 and exits, next full start requests browser authorization once.
12. **Relay outage:** with VPS unavailable, local backend-only bare launch/attach still works;
    full relay start/status reports degraded and does not erase a valid credential.
13. **Discovery regression:** after Windows is online, the real iPhone credential discovers both
    `primary-opencode` and `secondary-opencode` and can list sessions from each target.
14. **No collateral damage:** Mac target, paired phone credential, owner passkey, Caddy, FRPS,
    and unrelated Windows OpenCode native commands remain unchanged.
15. **Name synchronization:** rename Windows in the Dashboard and verify `/relay/targets`, the
    next heartbeat response, protected local credential, and status output all show it; then run
    the local rename command and verify the Dashboard changes. IDs, ports, tokens, PIDs, and
    backend generation must remain byte-for-byte unchanged in both directions.

## 12. Handoff evidence expected from the Windows agent

Return all of the following:

- installed file map and the resolved untouched real OpenCode path;
- test-suite output for the matrix above;
- redacted JSON from start, repeated start, restart, stop, second stop, and start-after-stop;
- listener/process identity snapshots before and after each mutation;
- Dashboard screenshot showing Windows online and the existing Mac/phone entries;
- relay discovery and session-count probe for both targets;
- a statement that no raw token/password was printed, committed, or transmitted outside TLS.
