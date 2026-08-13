# OpenCode Relay

A Node.js relay that lets OpenCode Mobile control the OpenCode sessions on every authorized machine connected to the relay. The web Dashboard uses a passkey; pairing a phone is a one-tap QR flow with no URL, username, password, or token entry.

```text
Browser ──Passkey──▶ Dashboard ──one-time QR──▶ iPhone
                                              │
                                              ▼
Mobile App ──permanent device credential──▶ Relay ──▶ authorized OpenCode targets
```

The relay stores only a SHA-256 hash of each paired device credential and translates
`Authorization: Bearer <device-token>` (from mobile clients) into
`Authorization: Basic <user:pass>` (to the local OpenCode server) and enforces each
client's target/directory scope. It runs on your VPS/reverse-proxy host, behind Caddy or
nginx.

---

## Why

OpenCode's `serve` mode exposes a full REST API with HTTP Basic Auth. You can tunnel it to a VPS via SSH (`ssh -R 4096:localhost:4096`). But:

1. You don't want every mobile device holding your `OPENCODE_SERVER_PASSWORD`
2. You want to add/revoke devices individually
3. You want the app to work for multiple users, each with their own token

This relay gives each paired phone its own credential. The QR code is single-use and expires after two minutes. The resulting device credential has no time-based expiry, survives relay restarts, and remains valid until it is revoked from the passkey-protected Dashboard. Revocation also closes that device's active event streams immediately.

---

## Quick Start

### 1. Deploy the package

```bash
RELAY_SSH_ALIAS=your-vps ./deploy/deploy-relay.sh
```

### 2. Install

```bash
# Create code and credential directories, then install the locked dependencies
sudo mkdir -p /opt/opencode-relay /etc/opencode-relay
sudo npm ci --omit=dev --prefix /opt/opencode-relay

# Create tokens file
sudo cp /tmp/tokens.example.json /etc/opencode-relay/tokens.json
sudo chmod 600 /etc/opencode-relay/tokens.json

# Generate a real token
NODE_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "Generated token: $NODE_TOKEN"

# Edit tokens.json with real values
sudo nano /etc/opencode-relay/tokens.json
```

### 3. Configure tokens

```json
{
  "tokens": {
    "my-iphone": {
      "token": "a1b2c3d4e5f6...",
      "name": "My iPhone",
      "basic_user": "opencode",
      "basic_pass": "YOUR_OPENCODE_SERVER_PASSWORD",
      "directory": null
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `token` | Yes | The bearer token the mobile app sends. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `name` | No | Human-readable label (shows in relay logs) |
| `basic_user` | No | OpenCode basic auth username (default: `opencode`) |
| `basic_pass` | Yes | OpenCode basic auth password (`OPENCODE_SERVER_PASSWORD`) |
| `directory` | No | Pin this device to a specific project directory |

Tokens are hot-reloaded every 60 seconds. Add, remove, or change tokens without restarting.

The preferred v2 configuration separates backend targets from clients and supports
`pinnedDirectory` plus `allowedDirectories`. Mobile clients send the same canonical
directory in the OpenCode `directory` query parameter and `X-OpenCode-Directory` header.
The relay validates both inputs, rejects conflicts/disallowed directories, and rewrites a
pinned directory before forwarding. The legacy `tokens` shape above remains supported and
is migrated in memory.

An owner client may authorize more than one backend with `targetIDs` while retaining
`targetID` as its default. `GET /relay/targets` returns only the authorized target IDs and
display names; it never returns target addresses or Basic credentials. Requests select a
machine with `X-OpenCode-Target`. The relay validates that selection before proxying, so a
session discovered on one machine cannot be accidentally dispatched to another.

```json
{
  "version": 2,
  "targets": {
    "windows": { "displayName": "Windows workstation", "host": "127.0.0.1", "port": 4096, "basicUser": "opencode", "basicPass": "..." },
    "mac": { "displayName": "MacBook", "host": "127.0.0.1", "port": 4098, "basicUser": "opencode", "basicPass": "..." }
  },
  "clients": {
    "owner-phone": {
      "clientID": "owner-phone",
      "displayName": "Owner phone",
      "token": "...",
      "targetID": "windows",
      "targetIDs": ["windows", "mac"],
      "pinnedDirectory": null,
      "allowedDirectories": null
    }
  }
}
```

### 4. Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-relay
sudo systemctl status opencode-relay
```

Verify:

```bash
curl http://127.0.0.1:4097/health
# {"status":"ok","relay":true,"upstream":"127.0.0.1:4096","devices":1}
```

### 5. Expose via reverse proxy

**Caddy:**

```caddy
opencode.example.com {
    tls /etc/caddy/certs/example.com.pem /etc/caddy/certs/example.com.key

    # Preserve prompt and legacy event streams without buffering.
    reverse_proxy 127.0.0.1:4097 {
        flush_interval -1
    }
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name opencode.example.com;
    # Preserve prompt and legacy event streams without buffering.
    location / {
        proxy_pass http://127.0.0.1:4097;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 3600s;
    }
}
```

### 6. Register the owner passkey

Set the public HTTPS origin and a private bootstrap secret in `/etc/opencode-relay/relay.env`:

```dotenv
RELAY_PUBLIC_ORIGIN=https://opencode.example.com
PASSKEY_STATE_PATH=/etc/opencode-relay/passkeys.json
PASSKEY_BOOTSTRAP_TOKEN=<at-least-24-random-characters>
PAIRING_SOURCE_CLIENT_ID=owner-phone
```

Open `https://opencode.example.com/#setup=<bootstrap-secret>` once and create the owner passkey. Browser navigation and referrers do not send the fragment; the page submits it only to the same relay during registration. Registration is disabled as soon as the first passkey is stored.

### 7. Pair and manage phones

1. Open `https://opencode.example.com` and sign in with the passkey.
2. Press **Connect phone** and scan the QR code with the iPhone camera.
3. Open OpenCode when prompted. The app exchanges the single-use code and stores the returned device credential in the iOS Keychain.
4. Use the Dashboard device list to inspect pairing time and last use, or press **Revoke**. No relay restart is required.

The manual Bearer/Basic form remains an advanced recovery path in the app; it is not needed for normal pairing.

### 8. Authorize and monitor machines

`opencode --relay_server start` and `restart` use an OAuth device-authorization flow.
The CLI sends machine metadata and its local OpenCode Basic credential over TLS, receives a
short-lived device code, and opens `verification_uri_complete` in the user's normal browser.
The owner signs in with a passkey and explicitly approves the request in the Dashboard.

The token endpoint returns a revocable machine bearer and FRP transport configuration once.
Only a SHA-256 hash of the bearer is stored in `passkeys.json`; the CLI stores the original in
`~/.config/opencode-relay/machine.json` with mode `0600`. Authorization remains valid until the
owner revokes the machine. A revoked target is removed from phone discovery immediately and
does not fall back to an identically named legacy static target.

The Dashboard always shows three explicit sections:

- pending machine authorization requests, with Approve and Deny actions;
- machines, including local 4096 health, fresh heartbeat, VPS reachability, target and port;
- authorized phones, including paired/last-used time and a Revoke action.

Machine states are `online`, `degraded`, `offline`, `stopped`, or `revoked`. The relay decides them from
both the outbound machine heartbeat and an authenticated VPS-side probe, so a local server
cannot be mistaken for a working public connection. The probe has a 4 s timeout, and a
machine must fail two consecutive probes before it can flip from `online` to `degraded`, so a
sub-minute data-plane blip (for example a client sync burst through the frp tunnel) does not
flicker the dashboard. Recovery back to `online` is immediate on the first successful probe.

The public machine endpoints are:

| Endpoint | Authentication | Purpose |
|----------|----------------|---------|
| `POST /api/oauth/device/code` | rate limited | Start a ten-minute authorization request |
| `POST /api/oauth/token` | one-time device code | Poll for owner approval and retrieve credentials once |
| `GET /api/machine/me` | machine bearer | Validate the persistent machine credential |
| `DELETE /api/machine/me` | machine bearer | Revoke the calling machine before a local credential purge |
| `POST /api/machine/heartbeat` | machine bearer | Report local 4096 health and versions |

Approve, deny, list, and administrative revoke operations require a same-origin
passkey web session. A machine may revoke only its own credential through the
authenticated DELETE endpoint.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_PORT` | `4097` | Port the relay listens on |
| `OC_HOST` | `127.0.0.1` | OpenCode server hostname |
| `OC_PORT` | `4096` | OpenCode server port |
| `TOKENS_PATH` | `/etc/opencode-relay/tokens.json` | Path to tokens file |
| `TOKEN_RELOAD_SEC` | `60` | How often to hot-reload tokens |
| `RELAY_PUBLIC_ORIGIN` | `http://localhost:<relay-port>` | Exact HTTPS origin used for WebAuthn and pairing links |
| `PASSKEY_STATE_PATH` | Beside `TOKENS_PATH` | Persistent passkey and paired-device state file |
| `PASSKEY_BOOTSTRAP_TOKEN` | None | Private first-registration secret; ignored after the first passkey exists |
| `PAIRING_SOURCE_CLIENT_ID` | First configured client | Static client whose target and directory scope new phones inherit |
| `FRPS_CONFIG_PATH` | `/etc/frp/frps.toml` | Protected FRP server configuration used to provision approved machines |
| `FRP_SERVER_PUBLIC_HOST` | None | Public frps hostname/IP issued to newly enrolled machines so `frpc` can dial the server directly instead of through an SSH local forward; empty keeps the legacy two-layer transport |
| `MACHINE_REMOTE_PORT_MIN` | `4100` | First dynamically allocated machine port |
| `MACHINE_REMOTE_PORT_MAX` | `4199` | Last dynamically allocated machine port |
---

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  iOS/Android │────▶│  VPS / Cloud VM  │────▶│  Local Machine    │
│  Mobile App  │     │                  │     │  (Windows/Mac)    │
│              │     │  Caddy :443      │     │                   │
│  Bearer: abc  │     │    │             │     │  opencode serve   │
│              │     │    ▼             │     │  :4096            │
│              │     │  relay :4097 ────┼───▶ │  (headless API)   │
│              │     │    │             │ SSH │                   │
│              │     │  Basic: user:pass│ -R  │                   │
└──────────────┘     └──────────────────┘     └──────────────────┘
```

1. **Local machine** runs `opencode serve --port 4096` + `OPENCODE_SERVER_PASSWORD=xxx`
2. **SSH reverse tunnel**: `ssh -R 4096:localhost:4096 vps` (persistent, auto-reconnect)
3. **VPS relay** (this repo): listens on `127.0.0.1:4097`, validates bearer tokens, forwards with basic auth to `127.0.0.1:4096` (which is actually the local machine via SSH tunnel)
4. **Caddy/nginx** terminates TLS, proxies `opencode.example.com → 127.0.0.1:4097`
5. **Dashboard** authenticates the owner with WebAuthn and issues a two-minute, single-use QR code
6. **Mobile app** exchanges that code once, stores its no-expiry credential in the Keychain, and connects to every target allowed by the pairing source client

---

## Security

- **Token comparison**: Uses `crypto.timingSafeEqual` (constant-time) to prevent timing attacks
- **Bound to localhost**: The relay only listens on `127.0.0.1` — never exposed directly to the internet
- **TLS termination**: Your reverse proxy (Caddy/nginx) handles HTTPS
- **File permissions**: `tokens.json` should be `chmod 600`, owned by the relay user
- **No token in logs**: Authorization headers are stripped from all logging
- **Passkey owner access**: Dashboard mutations require user-verified WebAuthn and a same-origin session
- **One-time bootstrap**: the setup secret stops working after the first passkey is registered
- **Persistent revocable devices**: raw phone credentials are returned once and never written to disk; only their hashes are stored
- **Directory scope**: query and header directory inputs are validated against the client
  pin/allowlist before proxying
- **Health endpoint**: Unauthenticated `/health` only exposes device count, not tokens

---

## Deploy with Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY relay.mjs .
EXPOSE 4097
ENV TOKENS_PATH=/data/tokens.json
VOLUME /data
CMD ["node", "relay.mjs"]
```

```bash
docker run -d \
  -p 127.0.0.1:4097:4097 \
  -v /etc/opencode-relay:/data \
  --name opencode-relay \
  opencode-relay
```

---

## Related Repos

- **[OpenCode Mobile](https://github.com/your-org/opencode-mobile)** — iOS/Android app that connects through this relay
- **[OpenCode](https://github.com/anomalyco/opencode)** — The AI coding agent this relay fronts

---

## Managing Paired Phones

### Add a device

Sign in to the web Dashboard with the owner passkey and press **Connect phone**.

### Revoke a device

Press **Revoke** beside the device in the Dashboard. New requests fail immediately and active streams are closed.

### List active devices

```bash
curl http://127.0.0.1:4097/health
# {"devices": 3, ...}
```

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `502 upstream_unreachable` | Is `opencode serve` running? Is the SSH tunnel active? `ss -tlnp \| grep 4096` |
| `401 invalid_token` | Token mismatch. Check `tokens.json` syntax. Regenerate token. |
| Relay won't start | `sudo journalctl -u opencode-relay -n 30` |
| Mobile can't connect | Is Caddy running? `sudo systemctl status caddy`. Is DNS pointing to VPS? |

---

## License

MIT
