# Local launcher - macOS

This is the self-contained macOS implementation of the relay-aware OpenCode
launcher. A bare `opencode` attaches a disposable TUI to one persistent local
`opencode serve`; the same backend is exposed through SSH + FRP to the relay and
the mobile app. `opencode --local` always executes the untouched original CLI.

The Windows implementation in [`../windows/`](../windows) defines the shared
behavioral contract. The macOS implementation uses zsh and process identity
proofs appropriate to Darwin but preserves the same command and exit-code
semantics.

## Files

| File | Role |
|------|------|
| `opencode` | Outer PATH wrapper. Dispatches lifecycle, local, interactive, and pass-through forms without loading relay state. The installer renders the absolute real OpenCode path into it. |
| `opencode-launch` | Authenticated backend preflight and interactive `attach`, with a lease for orderly restart/stop. |
| `opencode-relay-server` | Product orchestrator for backend, machine OAuth, FRP tunnel, and heartbeat agent. |
| `opencode-relay-server-core` | Ownership-safe backend lifecycle controller and TUI lease registry. |
| `common.sh` | Private config, authenticated health probes, process identity, state, lock, generation, and shutdown primitives. |
| `opencode-frp-tunnel` | SSH local-forward plus `frpc`, configured from the server-issued machine transport assignment. |
| `opencode-machine-auth.mjs` | OAuth device authorization, rename/revoke, and atomic machine credential/`frpc.toml` persistence. |
| `opencode-machine-agent` / `.mjs` | Detached heartbeat process and its lifecycle wrapper. |
| `opencode-daemon-launcher.mjs` | Detached, shell-free process spawn helper. |
| `opencode-client-launcher.mjs` | TUI child/lease registration and signal forwarding. |
| `install.sh` | Atomic install, update, doctor, and uninstall workflow. |
| `env.example` | Secret-free configuration template. |

## Prerequisites

- macOS with `/bin/zsh`, `ssh`, `nc`, `lsof`, `curl`, `jq`, and `openssl`.
- Node 22 or newer.
- A working OpenCode CLI.
- An SSH config alias that can reach the relay VPS.
- A deployed relay with machine OAuth and FRP transport configured.

Do not change Homebrew's `opencode` symlink. Put `~/.local/bin` before the real
OpenCode directory on `PATH`; the installer records the resolved original
executable and refuses a path that resolves back to its own wrapper.

## Install

```sh
/bin/zsh clients/macos/install.sh install \
  --relay-origin https://opencode.example.com \
  --ssh-alias opencode-vps
```

On first install the script:

1. Finds Node and the real OpenCode executable dynamically.
2. Backs up a pre-existing `~/.local/bin/opencode` before atomic replacement.
3. Generates a random local Basic-auth password in a mode-600 config file.
4. Installs every controller and launcher file; it does not depend on an old
   installation overlay.
5. Downloads FRP `v0.69.1` for the detected Darwin architecture and verifies
   the release archive against its pinned SHA-256 before installation.
6. Writes private installation metadata used for recursion checks and restore.

Use `--opencode PATH`, `--node PATH`, or `--frpc PATH` when discovery/download
is not appropriate. An existing config and machine credential are preserved.

Authorize the machine and start all components:

```sh
opencode --relay_server start
```

The command opens the relay's passkey dashboard. After approval, only a hash of
the machine bearer remains on the relay; the raw bearer and FRP assignment are
stored under `~/.config/opencode-relay/` with mode 600.

## Commands

```text
opencode                              attach to the shared backend
opencode --dir /path/to/project       attach with an explicit directory
opencode --local [args...]            execute real OpenCode with relay vars removed
opencode <non-interactive args...>    pass directly to real OpenCode

opencode --relay_server start [--json]
opencode --relay_server status [--json]
opencode --relay_server restart [--json]
opencode --relay_server stop [--json]
opencode --relay_server doctor [--json]
opencode --relay_server rename "Name" [--json]
opencode --relay_server restart tunnel [--json]
```

`start` is idempotent. A full restart advances the backend generation once and
restarts the transport/agent. `restart tunnel` leaves the backend and attached
TUIs alone. `stop` converges all managed components to stopped but retains the
machine credential.

## Safety invariants

- `--local` loads no relay module, performs no probe, and injects no Basic
  credential. It remains usable when relay files or state are broken.
- A foreign listener on the backend port fails closed. Stop/restart never kill
  a PID unless PID, creation time, executable, parent, and process group match
  the recorded identity.
- Backend readiness requires authenticated HTTP 200 responses from both
  `/global/health` and `/config`; an anonymous 401 is not readiness.
- Basic and bearer credentials are passed through environment/headers, never
  command-line arguments or logs.
- State and credential writes use a private temporary file followed by rename.
- The tunnel consumes `sshAlias`, FRP host/port, local-forward port, target ID,
  and remote port from the approved machine assignment. No tenant or port is
  compiled into the client.

## Update and uninstall

```sh
/bin/zsh clients/macos/install.sh update
/bin/zsh clients/macos/install.sh doctor
/bin/zsh clients/macos/install.sh uninstall
/bin/zsh clients/macos/install.sh uninstall --purge
```

Update replaces code atomically and preserves config, credentials, and state.
Normal uninstall stops managed processes, restores the prior `opencode` entry,
and keeps the credential for reinstall. `--purge` first calls the authenticated
machine self-revocation endpoint; it deletes config/state only after the relay
confirms revocation.

## Local files

| Path | Contents | Mode/lifecycle |
|------|----------|----------------|
| `~/.local/bin/opencode*` | Public command entry points | Installed code |
| `~/.local/lib/opencode-relay/` | Libraries, Node helpers, verified `frpc` | Directory 700 |
| `~/.config/opencode-relay/env` | Local Basic credentials and topology | File 600 |
| `~/.config/opencode-relay/machine.json` | Raw revocable machine bearer and assignment | File 600 |
| `~/.config/opencode-relay/frpc.toml` | Raw FRP token and assigned target port | File 600 |
| `~/.local/state/opencode-relay/` | PID identity, generations, leases, logs | Runtime only |

Never copy config or state into this repository.

## Tests

```sh
node --test clients/macos/test/*.test.mjs
```

Tests use temporary HOME/config/state directories and fake processes/services;
they do not contact a production relay or modify the active installation.
