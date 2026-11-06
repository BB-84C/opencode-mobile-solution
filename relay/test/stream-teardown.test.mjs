import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeUpstream } from './helpers/fake-upstream.mjs';

const relayDirectory = path.dirname(fileURLToPath(import.meta.url));
const relayRoot = path.dirname(relayDirectory);
const relayEntry = path.join(relayRoot, 'relay.mjs');
const testProcesses = new Set();

after(() => {
  for (const child of testProcesses) if (child.exitCode === null) child.kill('SIGKILL');
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForRelay(port, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`relay exited early with ${child.exitCode}`);
    const reachable = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (reachable) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('relay did not start within 10s');
}

async function startRelay({ upstreamPort, config }) {
  const port = await freePort();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-relay-teardown-'));
  const tokensPath = path.join(directory, 'tokens.json');
  await fs.writeFile(tokensPath, JSON.stringify(config));
  const child = spawn(process.execPath, [relayEntry], {
    cwd: relayRoot,
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      OC_HOST: '127.0.0.1',
      OC_PORT: String(upstreamPort),
      TOKENS_PATH: tokensPath,
      TOKEN_RELOAD_SEC: '3600',
      PASSKEY_STATE_PATH: path.join(directory, 'passkeys.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  testProcesses.add(child);
  await waitForRelay(port, child);
  return {
    port,
    async close() {
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      testProcesses.delete(child);
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

// Opens an SSE stream through the relay and resolves once headers arrive, so the
// caller knows the upstream leg is genuinely established before aborting it.
function openStream({ port, token }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: '127.0.0.1', port, path: '/event', method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } },
      (response) => {
        response.on('data', () => {});
        response.on('error', () => {});
        resolve({ request, statusCode: response.statusCode });
      },
    );
    request.once('error', reject);
    request.end();
  });
}

async function waitFor(predicate, { timeoutMs = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('aborting client SSE streams releases their upstream connections', async (t) => {
  const upstream = await createFakeUpstream();
  t.after(() => new Promise((resolve) => upstream.server.close(resolve)));

  const token = 'teardown-token-0123456789abcdef';
  const relay = await startRelay({
    upstreamPort: Number(new URL(upstream.url).port),
    config: {
      tokens: {
        phone: { token, name: 'Phone', basic_user: 'opencode', basic_pass: 'basic-secret', directory: null },
      },
    },
  });
  t.after(() => relay.close());

  const STREAMS = 5;
  const opened = [];
  for (let i = 0; i < STREAMS; i += 1) {
    const stream = await openStream({ port: relay.port, token });
    assert.equal(stream.statusCode, 200, 'relay should proxy the SSE stream');
    opened.push(stream);
  }

  await waitFor(() => upstream.activeEventClients() === STREAMS, {
    label: `upstream to see ${STREAMS} live streams`,
  });

  // Simulate what a phone does constantly: vanish mid-stream.
  for (const stream of opened) stream.request.destroy();

  // The regression this guards: the relay used to only run its bookkeeping
  // callback on client close and never destroy the upstream request, so every
  // reconnect leaked one upstream connection until the backend refused more and
  // /event answered 502 forever.
  await waitFor(() => upstream.activeEventClients() === 0, {
    timeoutMs: 5000,
    label: 'upstream connections to be released after clients abort',
  });

  assert.equal(upstream.activeEventClients(), 0, 'no upstream stream may outlive its client');
});
