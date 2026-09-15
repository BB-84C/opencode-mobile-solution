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
    pairingSourceClientID: 'owner',
    onDeviceRevoked: (clientID) => { revokedClientID = clientID; },
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
  return { baseUrl, controller, store, getRevokedClientID: () => revokedClientID };
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
  assert.match(dashboardHtml, /Passkey-protected devices/);
  assert.match(dashboardHtml, /Authorized phones/);
  // The machine-registration console is gone: the relay no longer enrols remote
  // machines over a tunnel, so the dashboard must not advertise that flow.
  assert.doesNotMatch(dashboardHtml, /Pending machine authorization/);
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

test('the pairing controller no longer claims the machine enrolment routes', async () => {
  const { baseUrl } = await fixture();

  // These routes drove the old flow: a remote machine asked for a device code,
  // an owner approved it in the console, and the machine dialled back through an
  // FRP/SSH tunnel. Transport is Tailscale's job now and targets are declared
  // statically, so the controller must stop claiming these paths rather than
  // merely stop using them -- an unreachable-but-live enrolment route is a door.
  //
  // 404 here is this fixture's fallback for an unclaimed route. The real relay
  // answers an unauthenticated request with 401 whatever the path, so read these
  // assertions as "the controller did not handle it", not as a deployed status.
  const deviceCode = await fetch(`${baseUrl}/api/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationID: 'macbook-installation-1234', hostname: 'siyu-macbook' }),
  });
  assert.equal(deviceCode.status, 404);

  const token = await fetch(`${baseUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: 'whatever' }),
  });
  assert.equal(token.status, 404);

  for (const route of ['/api/machine/approve', '/api/machine/revoke', '/api/machine/heartbeat']) {
    const response = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 404, `${route} should be gone`);
  }
});
