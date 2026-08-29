import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { createPasskeyPairing } from '../lib/passkey-pairing.mjs';
import { PairingStore } from '../lib/pairing-store.mjs';

const cleanups = new Set();

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-passkey-routes-'));
  const store = new PairingStore({
    statePath: path.join(directory, 'passkeys.json'),
    bootstrapToken: 'bootstrap-secret-with-32-bytes',
    machinePollIntervalMs: 1,
  });
  let revokedClientID = null;
  let revokedMachineID = null;
  const controller = createPasskeyPairing({
    publicOrigin: 'https://relay.example',
    store,
    getSnapshot: () => ({
      targets: new Map([
        ['windows', { displayName: 'Windows', host: '127.0.0.1', port: 4096, basicUser: 'opencode', basicPass: 'windows-secret' }],
        ['mac', { displayName: 'Mac', host: '127.0.0.1', port: 4098, basicUser: 'opencode', basicPass: 'mac-secret' }],
      ]),
      clients: new Map([['owner', {
        clientID: 'owner',
        displayName: 'Owner',
        targetID: 'windows',
        targetIDs: ['windows', 'mac'],
        pinnedDirectory: null,
        allowedDirectories: null,
      }]]),
    }),
    machineTransport: {
      frpToken: 'frp-server-secret',
      frpServerPort: 7000,
      localForwardPort: 17000,
      remotePortMin: 4100,
      remotePortMax: 4199,
    },
    getMachineStatuses: async (machines) => machines.map((machine) => ({
      ...machine,
      state: 'online',
      localHealthy: true,
      publicProbeReachable: true,
      publicReachable: true,
      probeFailureCount: 0,
      checkedAt: '2026-08-29T12:00:00.000Z',
      publicStatus: 200,
      sentinelSecret: 'must-not-leak',
    })),
    pairingSourceClientID: 'owner',
    onDeviceRevoked: (clientID) => { revokedClientID = clientID; },
    onMachineRevoked: (machine) => { revokedMachineID = machine.machineID; },
  });
  const server = http.createServer(async (req, res) => {
    if (!await controller.handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  cleanups.add(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { baseUrl, controller, store, getRevokedClientID: () => revokedClientID, getRevokedMachineID: () => revokedMachineID };
}

afterEach(async () => {
  await Promise.all([...cleanups].map((cleanup) => cleanup()));
  cleanups.clear();
});

function originHeaders(session) {
  return {
    Origin: 'https://relay.example',
    'Content-Type': 'application/json',
    ...(session ? { Cookie: `oc_relay_session=${encodeURIComponent(session)}` } : {}),
  };
}

test('serves a passkey dashboard and keeps pairing codes out of the mobile request path', async () => {
  const { baseUrl } = await fixture();
  const dashboard = await fetch(`${baseUrl}/pair`);
  const mobile = await fetch(`${baseUrl}/pair/mobile`);

  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, /Passkey-protected machines and phones/);
  assert.match(dashboardHtml, /Authorized phones/);
  assert.match(dashboardHtml, /Pending machine authorization/);
  assert.equal(dashboard.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await mobile.text(), /Opening OpenCode/);
});

test('generates registration options only with the private bootstrap secret', async () => {
  const { baseUrl } = await fixture();
  const denied = await fetch(`${baseUrl}/api/passkey/register/options`, {
    method: 'POST',
    headers: originHeaders(),
    body: JSON.stringify({ setup: 'wrong' }),
  });
  const allowed = await fetch(`${baseUrl}/api/passkey/register/options`, {
    method: 'POST',
    headers: originHeaders(),
    body: JSON.stringify({ setup: 'bootstrap-secret-with-32-bytes' }),
  });

  assert.equal(denied.status, 403);
  assert.equal(allowed.status, 200);
  const payload = await allowed.json();
  assert.equal(payload.options.rp.id, 'relay.example');
  assert.equal(payload.options.authenticatorSelection.residentKey, 'required');
  assert.equal(payload.options.authenticatorSelection.userVerification, 'required');
  assert.ok(payload.ceremony);
});

test('requires a passkey web session to create a QR, then exchanges it once for a permanent device token', async () => {
  const { baseUrl, store, controller } = await fixture();
  const denied = await fetch(`${baseUrl}/api/pairing/create`, {
    method: 'POST',
    headers: originHeaders(),
    body: '{}',
  });
  assert.equal(denied.status, 401);

  const session = store.createWebSession();
  const created = await fetch(`${baseUrl}/api/pairing/create`, {
    method: 'POST',
    headers: originHeaders(session),
    body: '{}',
  });
  assert.equal(created.status, 200);
  const pairing = await created.json();
  assert.match(pairing.mobileUrl, /^https:\/\/relay\.example\/pair\/mobile#code=/);
  assert.match(pairing.qrSvg, /^<svg/);
  const code = new URLSearchParams(new URL(pairing.mobileUrl).hash.slice(1)).get('code');

  const exchanged = await fetch(`${baseUrl}/api/pairing/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'Siyu iPhone' }),
  });
  assert.equal(exchanged.status, 200);
  const { connection } = (await exchanged.json());
  assert.deepEqual(connection, {
    name: 'Siyu iPhone',
    authType: 'bearer',
    token: connection.token,
    url: 'https://relay.example',
    clientID: connection.clientID,
    displayNameRevision: 1,
  });
  assert.match(connection.clientID, /^phone-/);
  assert.equal(connection.token.length, 64);
  assert.deepEqual(controller.authenticateBearer(connection.token).targetIDs, ['windows', 'mac']);

  const replay = await fetch(`${baseUrl}/api/pairing/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'Replay' }),
  });
  assert.equal(replay.status, 400);
});

test('synchronizes phone names in both directions, then revokes the credential', async () => {
  const { baseUrl, store, controller, getRevokedClientID } = await fixture();
  const pairing = store.createPairingCode({
    targetID: 'windows',
    targetIDs: ['windows', 'mac'],
    pinnedDirectory: null,
    allowedDirectories: null,
  });
  const issued = store.exchangePairingCode(pairing.code, 'Managed iPhone');
  const session = store.createWebSession();
  const status = await fetch(`${baseUrl}/api/passkey/status`, {
    headers: { Cookie: `oc_relay_session=${encodeURIComponent(session)}` },
  });
  assert.equal((await status.json()).devices[0].displayName, 'Managed iPhone');

  const dashboardRename = await fetch(`${baseUrl}/api/pairing/rename`, {
    method: 'POST',
    headers: originHeaders(session),
    body: JSON.stringify({ clientID: issued.client.clientID, displayName: 'Travel iPhone' }),
  });
  assert.equal(dashboardRename.status, 200);
  assert.equal((await dashboardRename.json()).device.displayNameRevision, 2);

  const phoneMe = await fetch(`${baseUrl}/api/pairing/me`, {
    headers: { Authorization: `Bearer ${issued.connection.token}` },
  });
  assert.equal((await phoneMe.json()).device.displayName, 'Travel iPhone');

  const phoneRename = await fetch(`${baseUrl}/api/pairing/name`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${issued.connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Pocket OpenCode' }),
  });
  assert.equal(phoneRename.status, 200);
  assert.equal((await phoneRename.json()).device.displayName, 'Pocket OpenCode');
  assert.equal(store.listDevices()[0].displayName, 'Pocket OpenCode');

  const invalidRename = await fetch(`${baseUrl}/api/pairing/name`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${issued.connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: '   ' }),
  });
  assert.equal(invalidRename.status, 400);

  const revoked = await fetch(`${baseUrl}/api/pairing/revoke`, {
    method: 'POST',
    headers: originHeaders(session),
    body: JSON.stringify({ clientID: issued.client.clientID }),
  });
  assert.equal(revoked.status, 200);
  assert.equal(getRevokedClientID(), issued.client.clientID);
  assert.equal(controller.authenticateBearer(issued.connection.token), null);
});

test('completes machine OAuth, synchronizes its name in both directions, and revokes it', async () => {
  const { baseUrl, store, getRevokedMachineID } = await fixture();
  const created = await fetch(`${baseUrl}/api/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      installationID: 'macbook-installation-1234',
      displayName: 'Siyu MacBook',
      hostname: 'siyu-macbook',
      platform: 'macos',
      clientVersion: '2',
      basicUsername: 'opencode',
      basicPassword: 'local-basic-password-with-enough-entropy',
      requestedTargetID: 'mac',
      requestedRemotePort: 4098,
    }),
  });
  assert.equal(created.status, 200);
  const grant = await created.json();
  assert.equal(grant.verification_uri_complete, `https://relay.example/?user_code=${grant.user_code}`);

  const pendingPoll = await fetch(`${baseUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: grant.device_code }),
  });
  assert.equal(pendingPoll.status, 400);
  assert.equal((await pendingPoll.json()).error, 'authorization_pending');

  const session = store.createWebSession();
  const status = await fetch(`${baseUrl}/api/passkey/status`, {
    headers: { Cookie: `oc_relay_session=${encodeURIComponent(session)}` },
  });
  const pendingStatus = await status.json();
  assert.equal(pendingStatus.pendingMachines[0].userCode, grant.user_code);
  assert.equal(JSON.stringify(pendingStatus).includes('local-basic-password'), false);

  const approved = await fetch(`${baseUrl}/api/machine/approve`, {
    method: 'POST',
    headers: originHeaders(session),
    body: JSON.stringify({ userCode: grant.user_code }),
  });
  assert.equal(approved.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const tokenResponse = await fetch(`${baseUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: grant.device_code }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();
  assert.equal(token.transport.frpToken, 'frp-server-secret');
  assert.equal(token.machine.targetID, 'mac');

  const dashboardRename = await fetch(`${baseUrl}/api/machine/rename`, {
    method: 'POST',
    headers: originHeaders(session),
    body: JSON.stringify({ machineID: token.machine.machineID, displayName: 'Desk Mac' }),
  });
  assert.equal(dashboardRename.status, 200);
  assert.equal((await dashboardRename.json()).machine.displayName, 'Desk Mac');

  const heartbeat = await fetch(`${baseUrl}/api/machine/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ localHealth: true, opencodeVersion: '1.17.18', controllerVersion: '2' }),
  });
  assert.equal(heartbeat.status, 200);
  const heartbeatPayload = await heartbeat.json();
  assert.deepEqual(Object.keys(heartbeatPayload.relayStatus).sort(), [
    'checkedAt',
    'probeFailureCount',
    'publicProbeReachable',
    'publicReachable',
    'publicStatus',
  ]);
  assert.equal(heartbeatPayload.relayStatus.publicProbeReachable, true);
  assert.equal(JSON.stringify(heartbeatPayload).includes('must-not-leak'), false);
  const me = await fetch(`${baseUrl}/api/machine/me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  assert.equal((await me.json()).machine.heartbeat.localHealth, true);

  const machineRename = await fetch(`${baseUrl}/api/machine/name`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Portable Mac' }),
  });
  assert.equal(machineRename.status, 200);
  assert.equal((await machineRename.json()).machine.displayName, 'Portable Mac');
  assert.equal(store.machineTargets()[0].displayName, 'Portable Mac');

  const revoked = await fetch(`${baseUrl}/api/machine/me`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(revoked.status, 200);
  assert.equal(getRevokedMachineID(), token.machine.machineID);
  const rejected = await fetch(`${baseUrl}/api/machine/me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(rejected.status, 401);
});
