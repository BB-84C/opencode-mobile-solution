# Architecture

Three components cooperate to let a phone or another computer drive OpenCode
sessions running on your own machines, without ever handing a client the backend
password: the OpenCode backends, the relay in front of them, and the clients.

The relay code is the same everywhere. Where it runs and how clients reach it is
your choice of **deployment route**:

| | VPS route | Tailnet route |
|---|---|---|
| Relay runs on | a VPS / always-on host, behind Caddy or nginx | the machine that runs the backends |
| Backends reach the relay through | an SSH reverse tunnel or FRP | loopback |
| Clients reach the relay through | a public HTTPS domain | a Tailscale network (`tailscale serve`) |
| Machines are added by | OAuth device-authorization enrollment | static targets in `tokens.json` |
| Setup | `relay/deploy/`, `relay/reverse-proxy/`, `clients/windows`, `clients/macos` | `host/deploy-macos.sh` |

Both routes serve the same clients: the iPhone app (`app/`) and the desktop
client OpenCode Cockpit (`desktop/`, macOS and Windows).

## VPS route

```
 Phone (app/)            Relay host                      Workstation
 ┌───────────┐           ┌─────────────────────┐         ┌───────────────────┐
 │ bearer    │  HTTPS    │ reverse proxy :443  │         │ opencode serve    │
 │ token     │──────────▶│ (Caddy / nginx, TLS)│         │ 127.0.0.1:4096    │
 └───────────┘           │        │            │  Basic  │ (Basic auth)      │
                         │        ▼            │────────▶│                   │
                         │ relay :4097 ────────┼─ tunnel │ clients/ wrapper  │
                         │ (bearer -> Basic)   │ (ssh -R │ manages backend   │
                         └─────────────────────┘  or frp)└───────────────────┘
```

### Backend — `opencode serve`

Each workstation runs one persistent `opencode serve` on `127.0.0.1:4096` behind
HTTP Basic auth (`OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`). The
local launcher in `clients/` starts this backend once and attaches disposable
TUIs to it, so the phone and the desktop share the same live sessions.

### Transport — SSH reverse tunnel or FRP

The backend is not exposed to the internet directly. A tunnel forwards it to the
relay host:

- **SSH reverse tunnel** — `ssh -N -R 4096:localhost:4096 your-vps`. Simple; one
  backend per remote port.
- **FRP** — an SSH local-forward to the FRP server plus an `frpc` client. This is
  the recommended path on Windows and supports multiple named machine targets on
  distinct remote ports.

The reverse proxy (Caddy or nginx) terminates TLS and forwards to the relay.
Disable response buffering there so prompt streaming and SSE event streams pass
through unbuffered.

### Machine authorization

Machines enroll through an OAuth-style device-authorization flow rather than a
static token:

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/oauth/device/code` | rate limited | Start an authorization request. |
| `POST /api/oauth/token` | one-time device code | Poll for approval and retrieve the machine bearer + FRP transport config once. |
| `GET /api/machine/me` | machine bearer | Validate the persistent credential. |
| `DELETE /api/machine/me` | machine bearer | Revoke the calling machine credential during an explicit purge. |
| `POST /api/machine/heartbeat` | machine bearer | Report local backend health. |

The CLI opens the dashboard for the owner to approve. The relay derives a
machine's state (`online` / `degraded` / `offline` / `stopped` / `revoked`) from
both its heartbeat and an authenticated VPS-side probe, so a healthy local
server is never mistaken for a working public connection.

### Local launcher contract

The `clients/` wrapper classifies the first argument:

- `--relay_server <action>` → lifecycle controller (start / status / restart /
  stop / doctor / rename, plus `restart tunnel`).
- `--local [args]` → the untouched real `opencode`, with no probes, modules, or
  credential injection. This is the escape hatch when relay files are broken.
- interactive forms (bare, `--dir`, `-c`, `-s`, `--fork`, `--mini`) → attach a
  disposable TUI to the shared backend, with a lease per TUI.
- anything else → pass straight through to the real `opencode`.

## Tailnet route

```
 Clients                                 Host (always on)
 ┌──────────────────┐   Tailscale       ┌──────────────────────────────────────┐
 │ app/  (iPhone)   │   HTTPS           │ tailscale serve :8443 (TLS, certs)   │
 │ desktop/ (macOS, │──────────────────▶│        │                             │
 │  Windows)        │   bearer token    │        ▼                             │
 └──────────────────┘                   │ relay 127.0.0.1:4097 (bearer → Basic)│
                                        │        │  X-OpenCode-Target          │
                                        │        ▼                             │
                                        │ opencode serve 127.0.0.1:4096        │
                                        │ opencode serve 127.0.0.1:4098 (opt.) │
                                        └──────────────────────────────────────┘
```

The host runs one or more persistent `opencode serve` processes on loopback.
`host/deploy-macos.sh --managed-backend name:port[:profile]` installs each as a
launchd job, installs the relay beside them, and registers every backend as a
static target. Backends on one host share one session database, so every backend
lists the same sessions; they differ in which process (and which model
configuration) runs the next prompt.

There is no tunnel and no public listener. `tailscale serve` publishes the relay
to the tailnet as `https://<machine>.<tailnet>.ts.net:8443` and terminates TLS
with certificates it issues and renews itself. It does not buffer server-sent
events (measured: about 11 ms over a direct connection). Every device is a
tailnet node; a client that also runs Shadowrocket, Clash or a similar VPN needs
the routing rules in [`clients/README.md`](../clients/README.md).

Machine enrollment and the `clients/` launchers are not used on this route.

## Relay — `relay/relay.mjs`

On both routes the relay listens only on `127.0.0.1:4097` and does four things:

- **Token translation.** A client sends `Authorization: Bearer <token>`. The
  relay validates it with a constant-time comparison and rewrites it to
  `Authorization: Basic <user:pass>` for the selected backend.
- **Multi-target routing.** A client may be authorized for several backends. The
  request selects one with `X-OpenCode-Target`; the relay validates the selection
  before proxying. `GET /relay/targets` returns only target IDs and display
  names — never addresses or credentials. Targets come from `tokens.json`
  (static) and, on the VPS route, from enrolled machines.
- **Directory scope.** The `directory` query parameter and `X-OpenCode-Directory`
  header are validated against the client's pin/allowlist; conflicts or
  disallowed directories are rejected before forwarding.
- **Pairing and machine authorization.** A passkey-protected dashboard (WebAuthn)
  issues single-use QR codes for phones and approves machine-enrollment requests.

One CORS policy (`relay/lib/cors.mjs`) answers every preflight and exposes the
headers the clients read (for example `X-Next-Cursor` on the paged session list),
which the desktop client needs because it runs in a browser origin.

## Clients — `app/` and `desktop/`

The iPhone app and the desktop client OpenCode Cockpit are the same Expo / React
Native code. The desktop client is an Electron shell that loads the app's web
export and adds what a page cannot do itself: the TUI keybindings, tray
residency, start at login and system notifications.

Clients follow the server through two kinds of event stream:

- **The open session's stream** (`/event`) delivers messages, tool output,
  status, todo lists and errors for the directory being viewed.
- **A global stream per backend** (`/global/event`) delivers events from every
  directory. The client keeps it open while the app runs and uses it for what
  needs the user wherever it happens: permission requests and questions (often
  raised by subagents in child sessions nobody has open) and failed turns. These
  drive the waiting badge and the red "Stopped" mark on the session list, the
  in-app banner, and desktop notifications.

A failed turn is not output. The server stores `{ name, data: { message } }` on
the assistant message (`info.error`) and emits `session.error`; the clients
render both as red error boxes, so a session never stops without a visible
reason.

## Phone pairing

1. The owner signs in to the dashboard with a passkey and presses **Connect
   phone**, producing a single-use QR code that expires in two minutes.
2. The app scans it and exchanges the code once at
   `POST /api/pairing/exchange`, receiving a revocable, no-expiry device
   credential it stores in the device keychain.
3. Only a SHA-256 hash of that credential is stored on the relay. Revoking a
   device from the dashboard closes its active streams immediately.

## Security model

- Credentials (device and machine bearers) are stored only as hashes; raw values
  are returned once.
- The relay binds to loopback; TLS belongs to the reverse proxy (VPS route) or
  to the tailnet layer (tailnet route).
- `tokens.json`, `passkeys.json`, `machine.json`, `frpc.toml`, and `*.env` hold
  live secrets and are git-ignored.
- Authorization headers are stripped from all relay logs.
- The first-registration bootstrap secret stops working once the first passkey
  exists.
