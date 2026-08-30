# Local launcher — Windows (reference implementation)

This is a relay-aware wrapper around `opencode`. With it installed, a bare
`opencode` in a terminal attaches to one shared, always-on backend instead of
starting a new server each time — and that shared backend is the same one the
relay exposes to your phone. `opencode --local` remains an untouched escape
hatch.

`opencode.cmd` in this template dispatches **only** relay behavior:
`--relay_server`, `--local`, interactive attach, and pass-through. It
deliberately carries no observability, telemetry, or background-service hooks —
add those in your own copy if you want them.

## Files

| File | Role |
|------|------|
| `opencode.cmd` | Outer dispatcher put earlier on `PATH` than the real `opencode`. Routes first-argument forms to the scripts below; passes everything else through. |
| `opencode-launch.ps1` | Interactive attach: preflight the backend, attach a disposable TUI, register a lease, inject Basic credentials into the child (never on the command line). Falls back to a local session if the backend is unreachable. |
| `opencode-local.ps1` | The `--local` escape hatch: run the real `opencode` with no probes, no modules, no credential injection. |
| `opencode-relay-server.ps1` | Lifecycle controller: `start` / `status` / `restart` / `stop` / `doctor` / `rename`, plus `restart tunnel`. |
| `opencode-relay-common.psm1` | Shared library: config, health probes, state, mutex, listener/PID ownership, leases, start/restart machinery. |
| `opencode-relay-machine.psm1` | Machine identity and transport (relay origin, SSH alias, FRP client config, direct-data-plane mode) resolution, plus the resident tunnel supervisor lifecycle (start/stop/status). |
| `opencode-relay-supervisor.ps1` | Resident watchdog loop that re-establishes the FRP tunnel after a transient network drop (VPN/NAT teardown, connection reset), under the controller's shared mutex, without ever touching the local backend. Launched by `start`, stopped first by `stop`/`restart`. |
| `opencode-machine-auth.mjs` | OAuth device-authorization client: enroll this machine with the relay and persist a revocable machine credential. |
| `opencode-machine-agent.mjs` / `opencode-machine-agent`-side calls | Heartbeat agent reporting local backend health to the relay. |
| `opencode-daemon-launcher.mjs` | Cross-platform helper that spawns detached background processes. |
| `opencode-serve-attach.ps1` | Serve/attach helper used by the controller. |
| `opencode-frp-tunnel.ps1` | FRP tunnel (SSH local-forward + `frpc`); kept for machines that still use the legacy two-layer transport. The managed tunnel in `opencode-relay-machine.psm1` prefers direct frpc-to-frps when `OPENCODE_FRP_DIRECT_HOST` is set. |
| `opencode-tunnel.ps1` | Alternative plain SSH reverse tunnel daemon. |
| `install-frpc.ps1` | Versioned FRPC `adopt` / `stage` / `activate` / `rollback` / `status` workflow with pinned checksums, tunnel-only lifecycle control, running-process readback, and automatic rollback. |

## Prerequisites

- `opencode` installed and on `PATH` (note its real path — the wrapper must call
  the real binary, never itself).
- PowerShell 7+, Node 22+, OpenSSH client, and `frpc` (matching your relay's
  FRP server version) if you use the FRP tunnel.

## Install

1. Copy every file in this folder into `%USERPROFILE%\.config\opencode\bin\`.
2. Put that directory **earlier on `PATH`** than the directory holding the real
   `opencode`, so `opencode.cmd` here is resolved first.
3. Point the wrapper at the real binary:
   `setx OPENCODE_REAL_CMD "%USERPROFILE%\AppData\Roaming\npm\opencode.cmd"`
   (adjust to your install path).
4. Point the launcher at your relay:
   `setx OPENCODE_RELAY_ORIGIN "https://opencode.example.com"` and
   `setx OPENCODE_RELAY_SSH_ALIAS "your-vps"` (an entry in your `~/.ssh/config`).

## Use

```
opencode                          # attach to the shared backend (starts it if needed)
opencode --dir C:\path\to\project # attach, scoped to a directory
opencode --local [args...]        # bypass the relay entirely; plain opencode
opencode --relay_server start     # authorize this machine + bring up backend + tunnel
opencode --relay_server status    # component health (add --json for machine output)
opencode --relay_server restart tunnel
opencode --relay_server stop
opencode --relay_server rename "My workstation"
```

`opencode --relay_server start` runs the device-authorization flow: it opens the
relay's passkey dashboard in your browser, where you approve this machine. After
approval it stores a revocable machine credential and brings up the tunnel and
heartbeat agent. The credential stays valid until you revoke it from the
dashboard. Start and restart may wait up to 90 seconds for a fresh VPS-side
relay probe before returning `Degraded`; this convergence timeout is independent
of the shorter local lifecycle timeout.

## Versioned FRPC installation

The installer pins the official Windows amd64 FRP `v0.71.0` archive:

- Asset: <https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_windows_amd64.zip>
- SHA-256: `9e5062e3e5cf07e67144a3a4acf175ef6a2486f3605dd6cf288bae34ab39819f`
- Provenance: the release's official
  [`frp_sha256_checksums.txt`](https://github.com/fatedier/frp/releases/download/v0.71.0/frp_sha256_checksums.txt)

The expected hash is a source-owned constant. A mismatch fails closed; the
installer never learns or rewrites the expected value from a downloaded file.
Run each phase explicitly from the repository or installed client directory:

```powershell
pwsh -NoProfile -File .\clients\windows\install-frpc.ps1 adopt -Json # existing root only
pwsh -NoProfile -File .\clients\windows\install-frpc.ps1 stage
pwsh -NoProfile -File .\clients\windows\install-frpc.ps1 status -Json
pwsh -NoProfile -File .\clients\windows\install-frpc.ps1 activate -Json
pwsh -NoProfile -File .\clients\windows\install-frpc.ps1 rollback -Json
```

`adopt` is the only path that can put a sentinel into a pre-existing production
FRP root. It lists and inspects the root, requires User-scope
`OPENCODE_FRPC_EXE` to name the only existing managed binary inside that root,
executes its actual `--version`, and accepts only v0.69.1. Unmanaged
executables, directories, reparse points, or other unrecognized content reject
adoption and leave the sentinel absent. `stage` never silently adopts an
existing directory.

`stage` is non-disruptive. It downloads and extracts only below the managed FRP
version-staging directory, then checks the archive SHA-256, actual `--version`,
and `frpc verify -c` against the current `frpc.toml`. It does not invoke the
controller or change User environment. The managed root, staging directories,
and every replacement/deletion are protected by structural path checks and
creation-time sentinels.

Production activation has a fixed contract:

1. Read the actual running FRPC PID, executable path, version, and hash; require
   it to be `v0.69.1` and to match User-scope `OPENCODE_FRPC_EXE`.
2. Invoke controller `stop tunnel`. This stops only supervisor, heartbeat agent,
   and FRPC; it never invokes a backend lifecycle command or touches port 4096.
3. Re-read and archive the old binary as `frpc-0.69.1.exe`, then verify the
   archive's actual version and hash.
4. Install the staged candidate as `frpc-0.71.0.exe`, verify it again, and set
   User-scope `OPENCODE_FRPC_EXE` to that versioned path.
5. Invoke controller `start tunnel`. Startup can consume the controller's full
   90-second VPS-probe convergence window; a live PID alone is not success.
6. Read the new running PID's executable path and actual version, then invoke a
   separate controller `status tunnel`. Activation is gated on the real
   tunnel-target payload: root `Status=Ready`, `Tunnel.Status=Running`, matching
   `Tunnel.FRPCPID`, a running heartbeat agent, and authorized/preserved machine
   authorization. Full-relay/backend aggregate state is not an activation gate.

Any post-stop failure restores the verified old User value, restarts only the
tunnel target, and reads back the running `v0.69.1` process plus independent
controller tunnel-target status. A healthy already-selected v0.71.0 activation
is idempotent and performs no stop or selection write. Recovery failures report
the non-secret failed step, restore/archive paths, tunnel controller status, and
the next rollback command.

One persistent `.install-frpc.lock` file serializes mutations through an
exclusive open handle. The file is intentionally retained after handle close:
an unlocked old file cannot wedge later runs, concurrent holders cannot race,
and there is no delete-after-dispose window.

Every external process call is bounded. Version and config probes use
file-backed stdout/stderr plus a bounded wrapper wait (10 and 15 seconds). The
controller runs through an out-of-process-tree `Win32_Process.Create` wrapper;
stdout/stderr go to a managed-root capture directory and an atomic completion
sentinel records the controller exit code. The installer polls that sentinel
instead of waiting for output EOF, so detached daemons may retain their file
handles without hanging activation. Its explicit 150-second timeout covers the
45-second lifecycle budget plus 90-second convergence budget. On timeout the
result names the failed step and capture path; cleanup occurs only when wrapper
PID, creation time, and `cmd.exe` identity match this call, and only that verified
descendant tree is stopped. Foreign or ambiguous processes are left untouched.

The archive download has a separate pinned 300-second network timeout through
`Invoke-WebRequest -TimeoutSec`. This is intentionally distinct from the
150-second controller/process budget: the former bounds HTTPS transfer, while
the latter covers local lifecycle plus relay-probe convergence. A network stall
therefore fails `stage` rather than waiting indefinitely.

The production FRP binary root comes from the Windows LocalApplicationData
known folder and has no dedicated environment override. The current FRPC
configuration can still be moved deliberately with the User-scope
`OPENCODE_RELAY_CONFIG_DIR`; test roots and injected providers require explicit
`-TestMode`.

| Exit code | Meaning |
|-----------|---------|
| `0` | Adopted, staged, activated, or status read completed; inspect `State` in JSON. |
| `20` | Verified rollback is running, including automatic safe rollback. |
| `21` | Recovery was attempted but the running rollback could not be confirmed. |
| `22` | Safety rejection: checksum/version/config/path/identity/lock contract failed. |
| `64` | Unsupported action or incomplete test-only provider contract. |

## Configuration knobs (environment)

| Variable | Purpose |
|----------|---------|
| `OPENCODE_REAL_CMD` | Path to the real `opencode` launcher. |
| `OPENCODE_RELAY_ORIGIN` | Your relay's public HTTPS origin. |
| `OPENCODE_RELAY_SSH_ALIAS` | SSH host alias for the legacy two-layer tunnel. |
| `OPENCODE_FRP_DIRECT_HOST` | Public frps host. When set, `frpc` dials the FRP server directly and the SSH local-forward layer is skipped entirely. |
| `OPENCODE_SERVER_PORT` | Local backend port (default `4096`). |
| `OPENCODE_FRPC_EXE` | Path to `frpc.exe`. |
| `OPENCODE_RELAY_SUPERVISOR_INTERVAL_MS` | Tunnel supervisor heal-check cadence in ms (default `30000`, floor `10000`). |
| `OPENCODE_MACHINE_HEARTBEAT_MS` | Machine heartbeat cadence in ms (default `30000`, floor `10000`); tunnel relay-status freshness is at least 90 seconds or three heartbeat intervals. |
| `OPENCODE_CONTROLLER_SCRIPT` / `OPENCODE_LOCAL_SCRIPT` / `OPENCODE_LAUNCH_SCRIPT` | Override script paths used by `opencode.cmd`. |

## Hermetic health-contract tests

These tests use fake process/status providers and dynamic ports. They do not
touch the live backend, User environment, or relay service:

```powershell
node --test --test-concurrency=1 "clients/windows/test/*.test.mjs"
pwsh -NoProfile -File ".\clients\windows\test\health-contract.Tests.ps1"
pwsh -NoProfile -File ".\clients\windows\test\install-frpc.Tests.ps1"
```
