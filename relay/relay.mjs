#!/usr/bin/env node
/**
 * opencode-relay.mjs — Lightweight token→basic-auth relay for OpenCode server.
 * Zero dependencies (Node 22+ built-ins only).
 *
 * Runs on VPS, listens on port 4097.
 * Mobile clients connect with:  Authorization: Bearer <device-token>
 * Relay translates to:          Authorization: Basic <base64(user:pass)>
 * Forwards to local OpenCode server at:  http://127.0.0.1:4096
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
import fs from 'node:fs';
import path from 'node:path';
import { authenticateBearer, resolveScope } from './lib/auth.mjs';
import { startConfigReloader } from './lib/config.mjs';
import { createPasskeyPairing } from './lib/passkey-pairing.mjs';
import { proxyRequest } from './lib/proxy.mjs';

// ── Config ────────────────────────────────────────────────────
const RELAY_PORT  = parseInt(process.env.RELAY_PORT || '4097', 10);
const OC_HOST     = process.env.OC_HOST || '127.0.0.1';
const OC_PORT     = parseInt(process.env.OC_PORT || '4096', 10);
const TOKENS_PATH = process.env.TOKENS_PATH || '/etc/opencode-relay/tokens.json';
const RELOAD_SEC  = parseInt(process.env.TOKEN_RELOAD_SEC || '60', 10);
const PUBLIC_ORIGIN = process.env.RELAY_PUBLIC_ORIGIN || `http://localhost:${RELAY_PORT}`;
const PASSKEY_STATE_PATH = process.env.PASSKEY_STATE_PATH || path.join(path.dirname(TOKENS_PATH), 'passkeys.json');
const FRPS_CONFIG_PATH = process.env.FRPS_CONFIG_PATH || '/etc/frp/frps.toml';
const activeStreamsByClient = new Map();

function readFrpToken(configPath) {
    try {
        const config = fs.readFileSync(configPath, 'utf8');
        const match = config.match(/^\s*auth\.token\s*=\s*["']([^"']+)["']\s*$/m);
        return match?.[1] || '';
    } catch {
        return '';
    }
}

const machineTransport = {
    frpToken: readFrpToken(FRPS_CONFIG_PATH),
    frpsHost: process.env.FRP_SERVER_PUBLIC_HOST || '',
    frpServerPort: parseInt(process.env.FRP_SERVER_PORT || '7000', 10),
    localForwardPort: parseInt(process.env.FRP_LOCAL_FORWARD_PORT || '17000', 10),
    remotePortMin: parseInt(process.env.MACHINE_REMOTE_PORT_MIN || '4100', 10),
    remotePortMax: parseInt(process.env.MACHINE_REMOTE_PORT_MAX || '4199', 10),
};

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

function closeStreamsForTarget(targetID) {
    for (const [clientID, active] of activeStreamsByClient) {
        for (const entry of active) {
            if (entry.targetID === targetID) entry.close();
        }
        if (active.size === 0) activeStreamsByClient.delete(clientID);
    }
}

const configReloader = startConfigReloader({
    tokensPath: TOKENS_PATH,
    defaultTarget: { host: OC_HOST, port: OC_PORT },
    reloadSec: RELOAD_SEC,
    onError: (error) => console.error(`[relay] WARNING: configuration rejected: ${error.message}`),
    onReload: closeRevokedStreams,
});

let passkeyPairing;

function targetRegistry(snapshot = configReloader.getSnapshot()) {
    const targets = new Map(snapshot.targets);
    if (!passkeyPairing) return targets;
    for (const targetID of passkeyPairing.store.managedTargetIDs()) targets.delete(targetID);
    for (const target of passkeyPairing.store.machineTargets()) {
        targets.set(target.targetID, {
            displayName: target.displayName,
            host: target.host,
            port: target.port,
            basicUser: target.basicUser,
            basicPass: target.basicPass,
        });
    }
    return targets;
}

function probeTarget(target) {
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
            headers: {
                Authorization: `Basic ${Buffer.from(`${target.basicUser}:${target.basicPass}`).toString('base64')}`,
            },
        }, (response) => {
            response.resume();
            response.once('end', () => resolve({ reachable: response.statusCode === 200, statusCode: response.statusCode }));
        });
        // A short sync burst can transiently saturate the machine's single tunnel,
        // so a single failed probe must not flip the badge. Two consecutive
        // failures (see machineStatuses) plus this generous timeout keep short
        // blips from surfacing as degraded.
        request.setTimeout(4_000, () => request.destroy(new Error('probe timeout')));
        request.once('error', () => resolve({ reachable: false, statusCode: null }));
        request.end();
    });
}

// targetID -> number of consecutive failed probes. Debounces the online ->
// degraded transition so sub-minute data-plane blips (for example an app sync
// burst knocking the frp work pool) do not flicker the dashboard.
const probeFailureCounts = new Map();

async function machineStatuses(machines) {
    const targets = targetRegistry();
    return Promise.all(machines.map(async (machine) => {
        if (machine.revokedAt) {
            return { ...machine, state: 'revoked', heartbeatFresh: false, localHealthy: false, publicReachable: false, publicStatus: null };
        }
        const probe = await probeTarget(targets.get(machine.targetID));
        const failures = probe.reachable ? 0 : (probeFailureCounts.get(machine.targetID) || 0) + 1;
        probeFailureCounts.set(machine.targetID, failures);
        const probeReachable = failures < 2;
        const heartbeatTime = Date.parse(machine.lastHeartbeatAt || '');
        const heartbeatFresh = Number.isFinite(heartbeatTime) && Date.now() - heartbeatTime <= 90_000;
        const localHealthy = heartbeatFresh && machine.heartbeat?.localHealth === true;
        const state = machine.heartbeat?.lifecycle === 'stopped'
            ? 'stopped'
            : heartbeatFresh && localHealthy && probeReachable
                ? 'online'
                : heartbeatFresh || probeReachable
                    ? 'degraded'
                    : 'offline';
        return {
            ...machine,
            state,
            heartbeatFresh,
            localHealthy,
            publicReachable: probeReachable,
            publicStatus: probe.statusCode,
        };
    }));
}

passkeyPairing = createPasskeyPairing({
    publicOrigin: PUBLIC_ORIGIN,
    statePath: PASSKEY_STATE_PATH,
    bootstrapToken: process.env.PASSKEY_BOOTSTRAP_TOKEN,
    pairingSourceClientID: process.env.PAIRING_SOURCE_CLIENT_ID,
    getSnapshot: configReloader.getSnapshot,
    machineTransport,
    getMachineStatuses: machineStatuses,
    onDeviceRevoked: closeStreamsForClient,
    onMachineRevoked: (machine) => closeStreamsForTarget(machine.targetID),
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
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-OpenCode-Directory,X-OpenCode-Target',
            'Access-Control-Max-Age': '86400',
        });
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
