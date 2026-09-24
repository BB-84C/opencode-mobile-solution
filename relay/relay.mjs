#!/usr/bin/env node
/**
 * opencode-relay.mjs — Lightweight token→basic-auth relay for OpenCode server.
 * Zero dependencies (Node 22+ built-ins only).
 *
 * Runs on the host machine next to the backends it fronts, listening on 4097.
 * Remote access is provided by Tailscale; the relay itself never binds a public
 * interface and never speaks TLS. TLS termination belongs to the tailnet layer.
 *
 * Clients connect with:  Authorization: Bearer <device-token>
 * Relay translates to:   Authorization: Basic <base64(user:pass)>
 * Forwards to a local OpenCode server, by default http://127.0.0.1:4096.
 * Several backends may run side by side (one per profile); each is registered
 * as its own target and selected with the X-OpenCode-Target header.
 *
 * Auth:
 *   - Tokens stored in /etc/opencode-relay/tokens.json
 *   - Token validation uses timingSafeEqual (constant-time comparison)
 *   - Invalid/missing tokens → 401
 *
 * Multi-user design:
 *   - Each device/user gets their own token → maps to their OpenCode instance
 *   - Tokens file is hot-reloaded every 60s (no restart needed to add users)
 *   - Token scoping: each token can optionally pin to a project directory
 *
 * Usage:
 *   node opencode-relay.mjs
 *   RELAY_PORT=4097 OC_PORT=4096 node opencode-relay.mjs
 */

import http from 'node:http';
import { preflightHeaders, responseHeaders } from './lib/cors.mjs';
import path from 'node:path';
import { authenticateBearer, resolveScope } from './lib/auth.mjs';
import { startConfigReloader } from './lib/config.mjs';
import { createPasskeyPairing } from './lib/passkey-pairing.mjs';
import { createMachineStatusMonitor } from './lib/machine-status-monitor.mjs';
import { proxyRequest } from './lib/proxy.mjs';

// ── Config ────────────────────────────────────────────────────
const RELAY_PORT  = parseInt(process.env.RELAY_PORT || '4097', 10);
const OC_HOST     = process.env.OC_HOST || '127.0.0.1';
const OC_PORT     = parseInt(process.env.OC_PORT || '4096', 10);
const TOKENS_PATH = process.env.TOKENS_PATH || '/etc/opencode-relay/tokens.json';
const RELOAD_SEC  = parseInt(process.env.TOKEN_RELOAD_SEC || '60', 10);
const PUBLIC_ORIGIN = process.env.RELAY_PUBLIC_ORIGIN || `http://localhost:${RELAY_PORT}`;
const PASSKEY_STATE_PATH = process.env.PASSKEY_STATE_PATH || path.join(path.dirname(TOKENS_PATH), 'passkeys.json');
const activeStreamsByClient = new Map();

function onProxyOpen({ clientID, clientToken, targetID, streaming, close }) {
    if (!streaming) return;
    if (!activeStreamsByClient.has(clientID)) activeStreamsByClient.set(clientID, new Set());
    activeStreamsByClient.get(clientID).add({ clientToken, targetID, close });
}

function onProxyClose({ clientID, clientToken, targetID, streaming, close }) {
    if (!streaming) return;
    const active = activeStreamsByClient.get(clientID);
    if (!active) return;
    for (const entry of active) {
        if (entry.clientToken === clientToken && entry.targetID === targetID && entry.close === close) active.delete(entry);
    }
    if (active.size === 0) activeStreamsByClient.delete(clientID);
}

function closeRevokedStreams(snapshot) {
    for (const [clientID, active] of activeStreamsByClient) {
        for (const entry of active) {
            if (authenticateClient(snapshot, entry.clientToken)?.clientID !== clientID) entry.close();
        }
    }
}

function closeStreamsForClient(clientID) {
    const active = activeStreamsByClient.get(clientID);
    if (!active) return;
    for (const entry of active) entry.close();
    activeStreamsByClient.delete(clientID);
}

const configReloader = startConfigReloader({
    tokensPath: TOKENS_PATH,
    defaultTarget: { host: OC_HOST, port: OC_PORT },
    reloadSec: RELOAD_SEC,
    onError: (error) => console.error(`[relay] WARNING: configuration rejected: ${error.message}`),
    onReload: closeRevokedStreams,
});

let passkeyPairing;

// Targets are declared statically in tokens.json. One entry per backend the
// host runs; a second backend on another port is just another target.
function targetRegistry(snapshot = configReloader.getSnapshot()) {
    return new Map(snapshot.targets);
}

function probeTarget(target, { signal } = {}) {
    return new Promise((resolve) => {
        if (!target) {
            resolve({ reachable: false, statusCode: null });
            return;
        }
        const request = http.request({
            hostname: target.host,
            port: target.port,
            path: '/global/health',
            method: 'GET',
            signal,
            headers: {
                Authorization: `Basic ${Buffer.from(`${target.basicUser}:${target.basicPass}`).toString('base64')}`,
            },
        }, (response) => {
            response.resume();
            response.once('end', () => resolve({ reachable: response.statusCode === 200, statusCode: response.statusCode }));
        });
        // A short sync burst can transiently saturate a backend, so a single
        // failed probe must not flip the badge. The monitor requires two
        // consecutive failures, and this generous timeout keeps short blips
        // from surfacing as degraded.
        request.setTimeout(4_000, () => request.destroy(new Error('probe timeout')));
        request.once('error', () => resolve({ reachable: false, statusCode: null }));
        request.end();
    });
}

let machineStatusMonitor;

passkeyPairing = createPasskeyPairing({
    publicOrigin: PUBLIC_ORIGIN,
    statePath: PASSKEY_STATE_PATH,
    bootstrapToken: process.env.PASSKEY_BOOTSTRAP_TOKEN,
    pairingSourceClientID: process.env.PAIRING_SOURCE_CLIENT_ID,
    getSnapshot: configReloader.getSnapshot,
    onDeviceRevoked: closeStreamsForClient,
});

// Health of every declared target is sampled continuously. Nothing consumes the
// cache yet; exposing it on /relay/targets so a client can tell which backend is
// alive belongs to the multi-backend work, not to this cleanup.
machineStatusMonitor = createMachineStatusMonitor({
    getTargets: targetRegistry,
    probeTarget,
    onError: (error) => console.error(`[relay] WARNING: target monitor refresh failed: ${error.message}`),
});
void machineStatusMonitor.start().catch((error) => {
    console.error(`[relay] WARNING: initial target monitor refresh failed: ${error.message}`);
});

function authenticateClient(snapshot, token) {
    const targets = targetRegistry(snapshot);
    return authenticateBearer(snapshot, token) ?? passkeyPairing.authenticateBearer(token, [...targets.keys()]);
}

// ── Health endpoint ───────────────────────────────────────────
function handleHealth(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'ok',
        relay: true,
        upstream: `${OC_HOST}:${OC_PORT}`,
        devices: configReloader.getSnapshot().clients.size + passkeyPairing.store.listDevices().length,
    }));
}

// ── Server ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    // Health check (no auth required)
    if (req.url === '/health' || req.url === '/relay/health') {
        return handleHealth(req, res);
    }

    if (await passkeyPairing.handle(req, res)) return;

    // CORS preflight (mobile apps need this)
    if (req.method === 'OPTIONS') {
        res.writeHead(204, preflightHeaders());
        return res.end();
    }

    // Auth check
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer',
            'Access-Control-Allow-Origin': '*',
        });
        return res.end(JSON.stringify({ error: 'missing_bearer_token' }));
    }

    const token = authHeader.slice(7); // strip "Bearer "
    const snapshot = configReloader.getSnapshot();
    const targetsByID = targetRegistry(snapshot);
    const client = authenticateClient(snapshot, token);
    if (!client) {
        res.writeHead(401, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        return res.end(JSON.stringify({ error: 'invalid_token' }));
    }

    const requestUrl = new URL(req.url || '/', 'http://relay');
    if (req.method === 'GET' && requestUrl.pathname === '/relay/targets') {
        const targets = (client.targetIDs ?? [client.targetID]).filter((targetID) => targetsByID.has(targetID)).map((targetID) => ({
            id: targetID,
            name: targetsByID.get(targetID)?.displayName ?? targetID,
        }));
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        return res.end(JSON.stringify({ targets }));
    }
    const requestedTargetID = typeof req.headers['x-opencode-target'] === 'string'
        ? req.headers['x-opencode-target']
        : undefined;
    const headerDirectory = typeof req.headers['x-opencode-directory'] === 'string'
        ? req.headers['x-opencode-directory']
        : undefined;
    const queryDirectory = requestUrl.searchParams.get('directory') || undefined;
    if (headerDirectory && queryDirectory && headerDirectory !== queryDirectory) {
        res.writeHead(403, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        return res.end(JSON.stringify({ error: 'directory_conflict' }));
    }
    const scope = resolveScope(client, headerDirectory ?? queryDirectory, requestedTargetID);
    if (!scope.ok) {
        res.writeHead(403, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        return res.end(JSON.stringify({ error: scope.error }));
    }
    const target = targetsByID.get(scope.targetID);
    if (!target) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_target' }));
    }

    // Proxy to OpenCode
    proxyRequest({
        clientReq: req,
        clientRes: res,
        target,
        scope: { ...scope, clientID: client.clientID, clientToken: token },
        onOpen: onProxyOpen,
        onClose: onProxyClose,
    });
});

server.listen(RELAY_PORT, '127.0.0.1', () => {
    console.error(`[relay] Listening on 127.0.0.1:${RELAY_PORT} → upstream ${OC_HOST}:${OC_PORT}`);
    console.error(`[relay] Tokens: ${TOKENS_PATH}`);
});

// ── Graceful shutdown ─────────────────────────────────────────
let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    machineStatusMonitor.close();
    configReloader.close();
    for (const active of activeStreamsByClient.values()) {
        for (const entry of active) entry.close();
    }
    activeStreamsByClient.clear();
    const forcedExit = setTimeout(() => process.exit(1), 25_000);
    forcedExit.unref();
    await new Promise((resolve) => server.close(resolve));
    clearTimeout(forcedExit);
    process.exit(0);
}
process.on('SIGTERM', () => {
    console.error('[relay] SIGTERM — shutting down');
    void shutdown();
});
process.on('SIGINT', () => {
    console.error('[relay] SIGINT — shutting down');
    void shutdown();
});
