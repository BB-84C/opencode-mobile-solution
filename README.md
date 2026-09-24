# OpenCode Remote

## 这是什么

把跑在自己电脑上的 OpenCode 会话，带到手机和另一台电脑上。

一台常开的主机跑 OpenCode 后端，中继在前面做鉴权和分流，客户端通过 Tailscale 内网连过来——不开公网端口，不经第三方服务器，凭证在自己手里。手机上能看同一批会话、发指令、看回复；换到桌面客户端是同一套界面，多一套键盘操作。一台主机可以挂多台机器，一个客户端也可以同时连多台主机。

**项目来自朋友 [BB-84C](https://github.com/BB-84C) 的 [opencode-mobile-solution](https://github.com/BB-84C/opencode-mobile-solution)**，这个分支在它的中继和手机端之上，改成了 tailnet 直连、加了 macOS 一键部署和 Electron 桌面端，去掉了原本的 VPS / 内网穿透那条路。应用图标也是他的作品，经本人同意后沿用。

## In English

A template for reaching your own [OpenCode](https://github.com/anomalyco/opencode)
sessions from a phone or another machine. It is a starting kit, not a hosted
service: you supply your own domain, tokens, and credentials.

It has three independent parts. Adopt them together, or take only the piece you
need.

| Part | What it is |
|------|------------|
| **`relay/`** | A small Node service for a VPS (or any always-on host). It fronts one or more OpenCode `serve` backends, translates each device's bearer token into the backend's Basic auth, enforces per-device target/directory scope, and hosts a passkey-protected dashboard for pairing phones and authorizing machines. |
| **`app/`** | An Expo / React Native client. It connects to a relay by scanning a pairing QR code or by entering a relay URL and credential. Rebuild it under your own bundle identifier and ship it to your own devices. |
| **`clients/`** | Local launchers that let `opencode` on a workstation either attach to a shared, relay-connected backend or run fully local. Both Windows and macOS implementations follow the same lifecycle and escape-hatch contract. |

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

1. **Relay** — run the service on the host that owns the backends. See
   [`relay/README.md`](relay/README.md); proxy examples live in
   [`relay/reverse-proxy/`](relay/reverse-proxy). Remote access is Tailscale's
   job, so nothing here is exposed to the public internet.
2. **App** — set your own identifiers in `app/app.json`, then build and run. See
   [`app/README.md`](app/README.md).

## Security notes

- The relay stores only SHA-256 hashes of device credentials. Raw credentials
  are returned once and never written to disk.
- `tokens.json`, `passkeys.json`, and `*.env` hold live secrets. They are
  git-ignored here; keep them that way.
- Rotate any credential that has ever been committed, printed, or shared.
- The relay listens only on `127.0.0.1`; TLS is the reverse proxy's job.

## Layout

```
relay/          VPS relay service (Node), systemd unit, deploy + proxy examples
app/            Expo / React Native client
clients/
  windows/      relay-aware opencode wrapper (complete reference)
  macos/        self-contained macOS launcher, installer, controller, and tests
docs/           architecture overview
```

## License

MIT — see [LICENSE](LICENSE).
