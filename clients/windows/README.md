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
dashboard.

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
| `OPENCODE_CONTROLLER_SCRIPT` / `OPENCODE_LOCAL_SCRIPT` / `OPENCODE_LAUNCH_SCRIPT` | Override script paths used by `opencode.cmd`. |
