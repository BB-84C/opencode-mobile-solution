import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDINARY_REQUEST_TIMEOUT_MS, isStreamingRequest } from '../lib/proxy.mjs';
import { createFakeUpstream } from './helpers/fake-upstream.mjs';

const relayDirectory = path.dirname(fileURLToPath(import.meta.url));
const relayRoot = path.dirname(relayDirectory);
const relayEntry = path.join(relayRoot, 'relay.mjs');
const testProcesses = new Set();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function request({ port, method = 'GET', pathname = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const client = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    client.once('error', reject);
    if (body !== undefined) client.write(body);
    client.end();
  });
}

function openEventStream({ port, headers }) {
  return new Promise((resolve, reject) => {
    const client = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/event',
      headers,
    });
    client.once('response', (response) => resolve({ client, response }));
    client.once('error', reject);
    client.end();
  });
}

async function waitForRelay(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`relay exited before readiness: ${child.exitCode}`);
    try {
      const response = await request({ port, pathname: '/health' });
      if (response.statusCode === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('relay did not become ready');
}

async function startRelay({
  upstreamPort,
  tokens,
  config = { tokens },
  upstreamPortOverride = upstreamPort,
  reloadSec = '3600',
}) {
  const port = await freePort();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-relay-test-'));
  const tokensPath = path.join(directory, 'tokens.json');
  await fs.writeFile(tokensPath, JSON.stringify(config));
  const child = spawn(process.execPath, [relayEntry], {
    cwd: relayRoot,
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      OC_HOST: '127.0.0.1',
      OC_PORT: String(upstreamPortOverride),
      TOKENS_PATH: tokensPath,
      TOKEN_RELOAD_SEC: reloadSec,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  testProcesses.add(child);
  await waitForRelay(port, child);
  return {
    port,
    writeConfig: (nextConfig) => fs.writeFile(tokensPath, JSON.stringify(nextConfig)),
    async close() {
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      testProcesses.delete(child);
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

async function withRelay(t, { upstream, tokens, config, upstreamPortOverride, reloadSec } = {}) {
  const relay = await startRelay({
    upstreamPort: upstream ? Number(new URL(upstream.url).port) : undefined,
    tokens,
    config,
    upstreamPortOverride,
    reloadSec,
  });
  t.after(() => relay.close());
  if (upstream) t.after(() => new Promise((resolve) => upstream.server.close(resolve)));
  return relay;
}

function tokenEntry(overrides = {}) {
  return {
    token: 'device-token',
    name: 'Test Device',
    basic_user: 'opencode',
    basic_pass: 'basic-secret',
    ...overrides,
  };
}

function bearer(token = 'device-token') {
  return { authorization: `Bearer ${token}` };
}

after(async () => {
  for (const child of testProcesses) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
});

test('keeps the five-minute timeout for ordinary requests but exempts legacy streams', () => {
  assert.equal(ORDINARY_REQUEST_TIMEOUT_MS, 300_000);
  assert.equal(isStreamingRequest({ url: '/session/abc', headers: {} }), false);
  assert.equal(isStreamingRequest({ url: '/event', headers: {} }), true);
  assert.equal(isStreamingRequest({ url: '/relay/v1/retired/stream', headers: {} }), false);
  assert.equal(isStreamingRequest({ url: '/unknown', headers: { accept: 'text/event-stream' } }), true);
});

test('proxies arbitrary relay-prefixed paths without protocol dispatch', async (t) => {
  const upstream = await createFakeUpstream();
  const relay = await withRelay(t, { upstream, tokens: { device: tokenEntry() } });
  const body = JSON.stringify({ protocol: 2, known: {} });

  const response = await request({
    port: relay.port,
    method: 'POST',
    pathname: '/relay/v1/retired/stream',
    headers: { ...bearer(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    body,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, Buffer.from(body));
  assert.equal(upstream.requests.at(-1).url, '/relay/v1/retired/stream');
});

test('forwards arbitrary methods, query strings, and JSON bodies unchanged', async (t) => {
  const upstream = await createFakeUpstream();
  const relay = await withRelay(t, { upstream, tokens: { device: tokenEntry() } });
  const body = JSON.stringify({ prompt: 'hello', value: 17 });

  const response = await request({
    port: relay.port,
    method: 'PATCH',
    pathname: '/session/abc?mode=fast&include=parts',
    headers: { ...bearer(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    body,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, Buffer.from(body));
  const captured = upstream.requests.at(-1);
  assert.equal(captured.method, 'PATCH');
  assert.equal(captured.url, '/session/abc?mode=fast&include=parts');
  assert.deepEqual(captured.body, Buffer.from(body));
});

test('forwards binary request bodies and chunked upstream responses byte-for-byte', async (t) => {
  const upstream = await createFakeUpstream();
  const relay = await withRelay(t, { upstream, tokens: { device: tokenEntry() } });
  const binary = crypto.randomBytes(513);
  const echo = await request({
    port: relay.port,
    method: 'PUT',
    pathname: '/binary',
    headers: { ...bearer(), 'content-type': 'application/octet-stream', 'content-length': binary.length },
    body: binary,
  });
  const chunked = await request({ port: relay.port, pathname: '/__test/chunked', headers: bearer() });

  assert.deepEqual(echo.body, binary);
  assert.equal(chunked.statusCode, 206);
  assert.equal(chunked.headers['x-upstream-mode'], 'chunked');
  assert.deepEqual(chunked.body, Buffer.from([0, 1, 2, 253, 254, 255]));
});

test('translates Bearer credentials to Basic credentials and replaces Host', async (t) => {
  const upstream = await createFakeUpstream();
  const relay = await withRelay(t, { upstream, tokens: { device: tokenEntry() } });
  const response = await request({
    port: relay.port,
    pathname: '/global/health',
    headers: { ...bearer(), host: 'untrusted.example:9000' },
  });

  assert.equal(response.statusCode, 200);
  const captured = upstream.requests.at(-1);
  assert.equal(captured.headers.authorization, `Basic ${Buffer.from('opencode:basic-secret').toString('base64')}`);
  assert.equal(captured.headers.host, new URL(upstream.url).host);
});

test('proxies authenticated OpenCode health and config', async (t) => {
  const upstream = await createFakeUpstream({ config: { directory: '/vault/workspace' } });
  const relay = await withRelay(t, { upstream, tokens: { device: tokenEntry() } });

  const [health, config] = await Promise.all([
    request({ port: relay.port, pathname: '/global/health', headers: bearer() }),
    request({ port: relay.port, pathname: '/config', headers: bearer() }),
  ]);

  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
  assert.deepEqual(JSON.parse(config.body), { directory: '/vault/workspace' });
});

test('registers SSE subscribers before server.connected and pipes legacy events byte-compatibly', async (t) => {
  const upstream = await createFakeUpstream();
  const relay = await withRelay(t, { upstream, tokens: { device: tokenEntry() } });
  const direct = await openEventStream({
    port: Number(new URL(upstream.url).port),
    headers: { authorization: `Basic ${Buffer.from('opencode:basic-secret').toString('base64')}` },
  });
  const relayed = await openEventStream({ port: relay.port, headers: bearer() });
  const directChunks = [];
  const relayedChunks = [];
  direct.response.on('data', (chunk) => directChunks.push(chunk));
  relayed.response.on('data', (chunk) => relayedChunks.push(chunk));

  await new Promise((resolve) => setTimeout(resolve, 10));
  upstream.publishEvent({ id: 'evt_live', aggregate_id: 'ses_1', seq: 1, type: 'session.updated', data: { title: 'ready' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  upstream.disconnectEvents();
  await Promise.all([
    new Promise((resolve) => direct.response.once('end', resolve)),
    new Promise((resolve) => relayed.response.once('end', resolve)),
  ]);

  assert.deepEqual(Buffer.concat(relayedChunks), Buffer.concat(directChunks));
  assert.match(Buffer.concat(relayedChunks).toString('utf8'), /event: server\.connected/);
  assert.match(Buffer.concat(relayedChunks).toString('utf8'), /id: evt_live/);
});

test('closes an active SSE stream after its client token is removed by a valid reload', async (t) => {
  const upstream = await createFakeUpstream();
  const relay = await withRelay(t, {
    upstream,
    tokens: { device: tokenEntry() },
    reloadSec: '1',
  });
  const { response } = await openEventStream({ port: relay.port, headers: bearer() });
  await new Promise((resolve) => response.once('data', resolve));

  const closed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('revoked SSE stream remained open')), 2_500);
    const finish = () => {
      clearTimeout(timeout);
      resolve();
    };
    response.once('end', finish);
    response.once('close', finish);
  });
  await relay.writeConfig({ tokens: {} });
  await closed;
  assert.equal(upstream.requests.at(-1).url, '/event');
});

test('forwards upstream 502 and 504 statuses and headers unchanged', async (t) => {
  const upstream = await createFakeUpstream();
  const relay = await withRelay(t, { upstream, tokens: { device: tokenEntry() } });
  const [badGateway, timeout] = await Promise.all([
    request({ port: relay.port, pathname: '/__test/status/502', headers: bearer() }),
    request({ port: relay.port, pathname: '/__test/status/504', headers: bearer() }),
  ]);

  assert.equal(badGateway.statusCode, 502);
  assert.equal(badGateway.headers['x-upstream-status'], '502');
  assert.equal(timeout.statusCode, 504);
  assert.equal(timeout.headers['x-upstream-status'], '504');
});

test('returns relay-generated 502 when the upstream is unreachable', async (t) => {
  const unavailablePort = await freePort();
  const relay = await withRelay(t, {
    tokens: { device: tokenEntry() },
    upstreamPortOverride: unavailablePort,
  });
  const response = await request({ port: relay.port, pathname: '/session/unavailable', headers: bearer() });

  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.body).error, 'upstream_unreachable');
});

test('forwards a token-pinned directory to the upstream', async (t) => {
  const upstream = await createFakeUpstream();
  const relay = await withRelay(t, {
    upstream,
    tokens: { device: tokenEntry({ directory: '/vault/pinned' }) },
  });
  const response = await request({
    port: relay.port,
    pathname: '/directory',
    headers: { ...bearer(), 'x-opencode-directory': '/client/supplied' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(upstream.requests.at(-1).headers['x-opencode-directory'], '/vault/pinned');
});

test('rewrites a client directory query to the token-pinned directory', async (t) => {
  const upstream = await createFakeUpstream();
  const relay = await withRelay(t, {
    upstream,
    tokens: { device: tokenEntry({ directory: '/vault/pinned' }) },
  });
  const response = await request({
    port: relay.port,
    pathname: '/session?directory=%2Fclient%2Fsupplied',
    headers: bearer(),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(upstream.requests.at(-1).url, '/session?directory=%2Fvault%2Fpinned');
  assert.equal(upstream.requests.at(-1).headers['x-opencode-directory'], '/vault/pinned');
});

test('legacy unscoped clients cannot inject a directory header', async (t) => {
  const upstream = await createFakeUpstream();
  const relay = await withRelay(t, { upstream, tokens: { device: tokenEntry({ directory: null }) } });
  const response = await request({
    port: relay.port,
    pathname: '/directory',
    headers: { ...bearer(), 'x-opencode-directory': '/client/controlled' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(upstream.requests.at(-1).headers['x-opencode-directory'], undefined);
});

test('rejects a token entry without a Basic password before proxying', async (t) => {
  const upstream = await createFakeUpstream({ password: 'undefined' });
  const relay = await withRelay(t, {
    upstream,
    tokens: { device: tokenEntry({ basic_pass: undefined }) },
  });
  const response = await request({ port: relay.port, pathname: '/global/health', headers: bearer() });

  assert.equal(response.statusCode, 401);
  assert.equal(upstream.requests.length, 0);
});

test('rejects a v2 client directory outside its allowlist with 403', async (t) => {
  const upstream = await createFakeUpstream();
  const relay = await withRelay(t, {
    upstream,
    config: {
      version: 2,
      targets: {
        home: {
          host: '127.0.0.1',
          port: Number(new URL(upstream.url).port),
          basicUser: 'opencode',
          basicPass: 'basic-secret',
        },
      },
      clients: {
        restricted: {
          clientID: 'restricted',
          displayName: 'Restricted Device',
          token: 'restricted-token',
          targetID: 'home',
          pinnedDirectory: null,
          allowedDirectories: ['/vault/allowed'],
        },
      },
    },
  });
  const probeRequestCount = upstream.requests.length;
  const response = await request({
    port: relay.port,
    pathname: '/directory',
    headers: { ...bearer('restricted-token'), 'x-opencode-directory': '/vault/disallowed' },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(upstream.requests.length, probeRequestCount);
});

test('rejects a disallowed directory supplied through the OpenCode query parameter', async (t) => {
  const upstream = await createFakeUpstream();
  const relay = await withRelay(t, {
    upstream,
    config: {
      version: 2,
      targets: {
        home: {
          host: '127.0.0.1',
          port: Number(new URL(upstream.url).port),
          basicUser: 'opencode',
          basicPass: 'basic-secret',
        },
      },
      clients: {
        restricted: {
          clientID: 'restricted',
          displayName: 'Restricted Device',
          token: 'restricted-token',
          targetID: 'home',
          pinnedDirectory: null,
          allowedDirectories: ['/vault/allowed'],
        },
      },
    },
  });
  const probeRequestCount = upstream.requests.length;
  const response = await request({
    port: relay.port,
    pathname: '/session?directory=%2Fvault%2Fdisallowed',
    headers: bearer('restricted-token'),
  });

  assert.equal(response.statusCode, 403);
  assert.equal(upstream.requests.length, probeRequestCount);
});

test('discovers only authorized machines and routes an explicit target without exposing credentials', async (t) => {
  const windows = await createFakeUpstream({ password: 'windows-secret' });
  const mac = await createFakeUpstream({ password: 'mac-secret' });
  t.after(() => new Promise((resolve) => windows.server.close(resolve)));
  t.after(() => new Promise((resolve) => mac.server.close(resolve)));
  const relay = await withRelay(t, {
    config: {
      version: 2,
      targets: {
        windows: {
          displayName: 'Windows workstation',
          host: '127.0.0.1',
          port: Number(new URL(windows.url).port),
          basicUser: 'opencode',
          basicPass: 'windows-secret',
        },
        mac: {
          displayName: 'MacBook',
          host: '127.0.0.1',
          port: Number(new URL(mac.url).port),
          basicUser: 'opencode',
          basicPass: 'mac-secret',
        },
      },
      clients: {
        owner: {
          clientID: 'owner',
          displayName: 'Owner iPhone',
          token: 'owner-token',
          targetID: 'windows',
          targetIDs: ['windows', 'mac'],
          pinnedDirectory: null,
          allowedDirectories: null,
        },
      },
    },
    upstreamPortOverride: Number(new URL(windows.url).port),
  });
  const windowsProbeRequestCount = windows.requests.length;

  const discovery = await request({ port: relay.port, pathname: '/relay/targets', headers: bearer('owner-token') });
  assert.equal(discovery.statusCode, 200);
  assert.deepEqual(JSON.parse(discovery.body), {
    targets: [
      { id: 'windows', name: 'Windows workstation' },
      { id: 'mac', name: 'MacBook' },
    ],
  });
  assert.equal(discovery.body.includes('secret'), false);
  assert.equal(discovery.body.includes('127.0.0.1'), false);

  const response = await request({
    port: relay.port,
    pathname: '/global/health',
    headers: { ...bearer('owner-token'), 'x-opencode-target': 'mac' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(mac.requests.at(-1).url, '/global/health');
  assert.equal(windows.requests.length, windowsProbeRequestCount);

  const forbidden = await request({
    port: relay.port,
    pathname: '/global/health',
    headers: { ...bearer('owner-token'), 'x-opencode-target': 'unknown' },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.deepEqual(JSON.parse(forbidden.body), { error: 'target_forbidden' });
});
