# OpenCode Remote

A template for reaching your own [OpenCode](https://github.com/anomalyco/opencode)
sessions from a phone or another machine. It is a starting kit, not a hosted
service: you supply your own domain, tokens, and credentials.

It has three independent parts. Adopt them together, or take only the piece you
need.

| Part | What it is |
|------|------------|
| **`relay/`** | A small Node service for a VPS (or any always-on host). It fronts one or more OpenCode `serve` backends, translates each device's bearer token into the backend's Basic auth, enforces per-device target/directory scope, and hosts a passkey-protected dashboard for pairing phones and authorizing machines. |
| **`app/`** | An Expo / React Native client. It connects to a relay by scanning a pairing QR code or by entering a relay URL and credential. Rebuild it under your own bundle identifier and ship it to your own devices. |
| **`clients/`** | The local launcher that lets `opencode` on your workstation either attach to a shared, relay-connected backend or run fully local. `clients/windows/` is a complete reference implementation; `clients/macos/` is a work-in-progress port. |

Nothing here hard-codes a server. The app has no built-in relay address; the
relay and launcher default hostnames are `opencode.example.com` placeholders you
replace with your own.

## How it fits together

```
 iOS / Android          VPS / always-on host          Your workstation
 ┌───────────┐          ┌──────────────────┐          ┌──────────────────┐
 │  app/     │  bearer  │  TLS proxy :443  │  bearer  │  opencode serve  │
 │  (phone)  │─────────▶│  (Caddy/nginx)   │          │  :4096           │
 └───────────┘          │      │           │  Basic   │  (headless API)  │
                        │      ▼           │─────────▶│                  │
                        │  relay :4097 ────┼── tunnel │  clients/ wrap   │
                        └──────────────────┘  (ssh/   │  opencode        │
                                               frp)   └──────────────────┘
```

1. Your workstation runs `opencode serve` on `127.0.0.1:4096` behind Basic auth.
2. A tunnel (SSH reverse tunnel or FRP) exposes that backend to the relay host.
3. The **relay** validates a phone's bearer token, rewrites it to Basic auth, and
   forwards to the selected backend. It never hands the backend password to a
   phone.
4. A reverse proxy terminates TLS and forwards to the relay on `127.0.0.1:4097`.
5. The **app** pairs once via a single-use QR code and stores a revocable,
   no-expiry device credential in the device keychain.

## Quick start

1. **Relay** — deploy the service to your host and expose it with a reverse
   proxy. See [`relay/README.md`](relay/README.md), with a deploy helper in
   [`relay/deploy/`](relay/deploy) and proxy examples in
   [`relay/reverse-proxy/`](relay/reverse-proxy).
2. **App** — set your own identifiers in `app/app.json`, then build and run. See
   [`app/README.md`](app/README.md).
3. **Local launcher** — install the wrapper so `opencode` attaches to the shared
   backend. See [`clients/windows/README.md`](clients/windows/README.md)
   (reference) or [`clients/macos/README.md`](clients/macos/README.md) (port in
   progress).

## Security notes

- The relay stores only SHA-256 hashes of device and machine credentials. Raw
  credentials are returned once and never written to disk.
- `tokens.json`, `passkeys.json`, `machine.json`, `frpc.toml`, and `*.env` hold
  live secrets. They are git-ignored here; keep them that way.
- Rotate any credential that has ever been committed, printed, or shared.
- The relay listens only on `127.0.0.1`; TLS is the reverse proxy's job.

## Layout

```
relay/          VPS relay service (Node), systemd unit, deploy + proxy examples
app/            Expo / React Native client
clients/
  windows/      relay-aware opencode wrapper (complete reference)
  macos/        macOS port (work in progress)
docs/           architecture overview
```

## License

MIT — see [LICENSE](LICENSE).
