# OpenCode Relay Proxy Deploy Attempt — 2026-07-11

## Target and pre-state

- SSH alias: `opencode-vps` (`<vps-host>`)
- Service: `opencode-relay.service`
- Relay path: `/opt/opencode-relay`
- Credentials path: `/etc/opencode-relay/tokens.json` (untouched)
- Pre-state: active old single-file relay, localhost `/health` returned HTTP 200.

## Attempted deployment

- Backup created: `/opt/opencode-relay.bak-20260711-2056`
- Deployed relay files: `relay.mjs`, `package.json`, and `lib/{auth,config,directory-path,proxy}.mjs`.
- Updated the unit from the repository version. Compatibility change: replaced the ineffective legacy reload-name comment with `TOKEN_RELOAD_SEC=60`; also applied the repository `UMask=0077` and `TimeoutStopSec=30s` directives. Tokens and runtime/FRP/Caddy configuration were not changed.
- Service restart completed and relay health/proxy/auth checks passed.

## Verification matrix

| Check | New proxy | Restored old relay |
|---|---|---|
| VPS localhost unauthenticated health | PASS (200) | PASS (200) |
| VPS localhost authenticated backend health | PASS (200) | PASS (200) |
| Missing bearer rejected | PASS (401) | PASS (401) |
| Public unauthenticated health | PASS (200) | PASS (200) |
| Public authenticated backend health | PASS (200) | PASS (200) |
| Public legacy `/event` initial SSE frame within 8 seconds | FAIL (curl timeout; no `server.connected`) | FAIL (same result) |

## Rollback and final state

- Rollback used: yes. Restored `/opt/opencode-relay` from `/opt/opencode-relay.bak-20260711-2056` and restarted `opencode-relay.service`.
- Removed the failed staged tree after capturing this report; only the rollback backup remains.
- Final service state: active. The public SSE initial-frame failure reproduced after rollback, so it is not evidence that the new transparent-proxy tree caused the failure.

## Follow-up SSE hop matrix and successful redeploy

### Diagnosis

- FRP evidence: `frps` listens on `127.0.0.1:4096`.
- With a 20-second bounded, unbuffered probe, the backend through FRP, the old localhost relay, and the full public Cloudflare path each delivered an SSE frame containing `server.connected`.
- The direct-to-local-Caddy probe initially failed TLS verification (`curl` exit 60) because the VPS does not trust the origin certificate chain when `opencode.example.com` is resolved to `127.0.0.1`. Retesting that isolated origin hop with certificate verification disabled delivered the same SSE frame.
- Therefore no hop lost SSE. The earlier 8-second probe was inconclusive; its timeout was not a relay, Caddy, FRP, or Cloudflare streaming defect.

### Fix scope

- No Caddy, Cloudflare, FRP, Windows, token, or credential changes were required.
- Fresh relay backup: `/opt/opencode-relay.bak-20260711-210345`.
- Redeployed the hardened transparent relay: `relay.mjs`, `package.json`, and `lib/{auth,config,directory-path,proxy}.mjs`.
- The already-aligned service unit retained `TOKENS_PATH` and `TOKEN_RELOAD_SEC=60`.

### Final verification

| Check | Result |
|---|---|
| Local relay health | PASS (200) |
| Local authenticated backend proxy | PASS (200, JSON object) |
| Missing bearer | PASS (401) |
| Bogus bearer | PASS (401) |
| Relay localhost `/event` | PASS: `server.connected` within 20s |
| Caddy-origin `/event` (local resolve, TLS verification disabled only for this isolation probe) | PASS: `server.connected` within 20s |
| Public Cloudflare `/event` | PASS: `server.connected` within 20s |

- Final deployed service: `active`, running the multi-file hardened relay from `/opt/opencode-relay`.
- Rollback status for the successful redeploy: unused. The earlier rollback backup remains preserved.
