# Local launcher — macOS (work in progress)

This folder is a **partial** macOS port of the Windows launcher in
[`../windows/`](../windows). It is not self-contained yet: the product-level
orchestrator scripts here depend on a backend "core" controller and a
`common.sh` library that a full install would place under `~/.local/...`, and
those are **not** included in this template.

Treat `clients/windows/` as the behavioral contract and finish the port against
it. The Windows implementation is complete and proven; macOS should match its
behavior, not redesign it.

## What is here

| File | Role | Status |
|------|------|--------|
| `opencode-machine-auth.mjs` | OAuth device-authorization client (enroll + persist machine credential, write `frpc.toml`). | Cross-platform, usable. |
| `opencode-machine-agent.mjs` | Heartbeat agent reporting local backend health. | Cross-platform, usable. |
| `opencode-machine-agent` | zsh wrapper for the agent lifecycle. | Depends on `common.sh`. |
| `opencode-relay-server` | Product-level orchestrator (start/status/restart/stop/doctor + tunnel). | Depends on `common.sh` and `opencode-relay-server-core`. |
| `opencode-launch` | Interactive attach / `--local` escape hatch. | Depends on `common.sh` and `opencode-client-launcher.mjs`. |
| `opencode-tunnel.sh` | POSIX SSH reverse tunnel daemon. | Usable standalone. |
| `install.sh` | Installs the wrappers into `~/.local/bin` and `~/.local/lib/opencode-relay`. | Expects the core to exist. |

## Still needed to complete the port

- `common.sh` — the bulk of the logic: config load, health probes, state,
  `flock` mutex, listener/PID ownership, leases, start/restart machinery. Port
  from `../windows/opencode-relay-common.psm1`.
- `opencode-relay-server-core` — the ownership-safe backend controller the
  product orchestrator wraps. Port from `../windows/opencode-relay-server.ps1`.
- `opencode-client-launcher.mjs` — the attach child launcher referenced by
  `opencode-launch`.

## Primitive mapping (Windows to macOS)

| Windows primitive | macOS replacement |
|-------------------|-------------------|
| User-scope registry / env store | `~/.config/opencode-relay/env` (mode 600), sourced explicitly |
| Named mutex | `flock` on `~/.local/state/opencode-relay/lock` (bounded `flock -w`) |
| `Get-NetTCPConnection -State Listen` | `lsof -nP -iTCP:4096 -sTCP:LISTEN -Fp` |
| PID identity (creation time + executable) | `ps -p <pid> -o lstart=,comm=`, captured at spawn, compared verbatim |
| Process-tree termination | process-group kill (`setsid` at spawn, `kill -- -<pgid>`), then poll port release |
| `%LOCALAPPDATA%\opencode-relay-server` | `~/.local/state/opencode-relay/` |

## Contracts that must survive the port exactly

- `--local` bypasses every probe, module, and credential injection — it execs
  the untouched `opencode` directly. It is the escape hatch when relay files are
  broken; never let the wrapper recurse into itself.
- `start` is idempotent; a foreign (unmanaged) listener on the backend port must
  fail closed and never be killed.
- Readiness is an authenticated 200 on both `/global/health` and `/config`; a
  401 is not healthy.
- Attach children receive `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`
  in their environment (never on the command line). `--local` and fallback
  children receive nothing.
- `restart` advances the backend generation exactly once and never kills
  unmanaged processes; a tunnel restart leaves the backend and attached TUIs
  untouched.

Configure the relay origin and SSH alias with `OPENCODE_RELAY_ORIGIN` and
`OPENCODE_RELAY_SSH_ALIAS` (both default to `opencode.example.com` /
`opencode-vps` placeholders).

## Tests

`test/` holds two POSIX-oriented tests for these client scripts. They are
hermetic (all state goes to a temporary HOME/config dir) and target macOS/Linux:

    node --test clients/macos/test/macos-machine-auth.test.mjs   # Node only
    node --test clients/macos/test/macos-lifecycle.test.mjs      # needs zsh

They are not expected to pass on Windows, where POSIX 0600 file modes are not
enforced.