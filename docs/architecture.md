# Architecture

Three components cooperate to let a phone drive OpenCode sessions running on your
own machines, without ever handing a phone the backend password.

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

## 1. Backend — `opencode serve`

Each workstation runs one persistent `opencode serve` on `127.0.0.1:4096` behind
HTTP Basic auth (`OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`). The
local launcher in `clients/` starts this backend once and attaches disposable
TUIs to it, so the phone and the desktop share the same live sessions.

## 2. Transport — SSH reverse tunnel or FRP

The backend is not exposed to the internet directly. A tunnel forwards it to the
relay host:

- **SSH reverse tunnel** — `ssh -N -R 4096:localhost:4096 your-vps`. Simple; one
  backend per remote port.
- **FRP** — an SSH local-forward to the FRP server plus an `frpc` client. This is
  the recommended path on Windows and supports multiple named machine targets on
  distinct remote ports.

## 3. Relay — `relay/relay.mjs`

The relay listens only on `127.0.0.1:4097` and does four things:

- **Token translation.** A mobile client sends `Authorization: Bearer <token>`.
  The relay validates it with a constant-time comparison and rewrites it to
  `Authorization: Basic <user:pass>` for the selected backend.
- **Multi-target routing.** A client may be authorized for several backends. The
  request selects one with `X-OpenCode-Target`; the relay validates the selection
  before proxying. `GET /relay/targets` returns only target IDs and display
  names — never addresses or credentials.
- **Directory scope.** The `directory` query parameter and `X-OpenCode-Directory`
  header are validated against the client's pin/allowlist; conflicts or
  disallowed directories are rejected before forwarding.
- **Pairing and machine authorization.** A passkey-protected dashboard (WebAuthn)
  issues single-use QR codes for phones and approves machine-enrollment requests.

The reverse proxy (Caddy or nginx) terminates TLS and forwards to the relay.
Disable response buffering there so prompt streaming and SSE event streams pass
through unbuffered.

## Phone pairing

1. The owner signs in to the dashboard with a passkey and presses **Connect
   phone**, producing a single-use QR code that expires in two minutes.
2. The app scans it and exchanges the code once at
   `POST /api/pairing/exchange`, receiving a revocable, no-expiry device
   credential it stores in the device keychain.
3. Only a SHA-256 hash of that credential is stored on the relay. Revoking a
   device from the dashboard closes its active streams immediately.

## Machine authorization

Machines enroll through an OAuth-style device-authorization flow rather than a
static token:

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/oauth/device/code` | rate limited | Start an authorization request. |
| `POST /api/oauth/token` | one-time device code | Poll for approval and retrieve the machine bearer + FRP transport config once. |
| `GET /api/machine/me` | machine bearer | Validate the persistent credential. |
| `POST /api/machine/heartbeat` | machine bearer | Report local backend health. |

The CLI opens the dashboard for the owner to approve. The relay derives a
machine's state (`online` / `degraded` / `offline` / `stopped` / `revoked`) from
both its heartbeat and an authenticated VPS-side probe, so a healthy local
server is never mistaken for a working public connection.

## Local launcher contract

The `clients/` wrapper classifies the first argument:

- `--relay_server <action>` → lifecycle controller (start / status / restart /
  stop / doctor / rename, plus `restart tunnel`).
- `--local [args]` → the untouched real `opencode`, with no probes, modules, or
  credential injection. This is the escape hatch when relay files are broken.
- interactive forms (bare, `--dir`, `-c`, `-s`, `--fork`, `--mini`) → attach a
  disposable TUI to the shared backend, with a lease per TUI.
- anything else → pass straight through to the real `opencode`.

## Security model

- Credentials (device and machine bearers) are stored only as hashes; raw values
  are returned once.
- The relay binds to loopback; TLS is the proxy's responsibility.
- `tokens.json`, `passkeys.json`, `machine.json`, `frpc.toml`, and `*.env` hold
  live secrets and are git-ignored.
- Authorization headers are stripped from all relay logs.
- The first-registration bootstrap secret stops working once the first passkey
  exists.
