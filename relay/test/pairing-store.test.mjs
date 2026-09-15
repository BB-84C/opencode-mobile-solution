import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { PairingStore } from '../lib/pairing-store.mjs';

const fixtureDirectories = new Set();

async function fixtureStore(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-pairing-store-'));
  fixtureDirectories.add(directory);
  return new PairingStore({
    statePath: path.join(directory, 'passkeys.json'),
    bootstrapToken: 'bootstrap-secret-with-32-bytes',
    ...options,
  });
}

afterEach(async () => {
  await Promise.all([...fixtureDirectories].map((directory) => fs.rm(directory, { recursive: true, force: true })));
  fixtureDirectories.clear();
});

test('allows the configured bootstrap token only until the first passkey is saved', async () => {
  const store = await fixtureStore();

  assert.equal(store.canBootstrap('bootstrap-secret-with-32-bytes'), true);
  assert.equal(store.canBootstrap('wrong-secret'), false);

  const owner = store.ensureOwner();
  store.saveCredential({
    id: 'credential-1',
    publicKey: new Uint8Array([1, 2, 3, 4]),
    counter: 0,
    transports: ['internal'],
    webauthnUserID: owner.webAuthnUserID,
    deviceType: 'multiDevice',
    backedUp: true,
  });

  assert.equal(store.canBootstrap('bootstrap-secret-with-32-bytes'), false);
  assert.equal(store.hasCredentials(), true);

  const reloaded = new PairingStore({
    statePath: store.statePath,
    bootstrapToken: 'bootstrap-secret-with-32-bytes',
  });
  assert.deepEqual([...reloaded.credentialForVerification('credential-1').publicKey], [1, 2, 3, 4]);
});

test('creates bounded web sessions and rejects them after expiry', async () => {
  let now = 1_000;
  const store = await fixtureStore({ now: () => now, webSessionTtlMs: 500 });
  const token = store.createWebSession();

  assert.equal(store.authenticateWebSession(token), true);
  assert.equal(store.authenticateWebSession('not-the-token'), false);

  now = 1_501;
  assert.equal(store.authenticateWebSession(token), false);
});

test('exchanges a pairing code once and authenticates only the returned device token', async () => {
  let now = 10_000;
  const store = await fixtureStore({ now: () => now, pairingTtlMs: 120_000 });
  const scope = {
    targetID: 'windows',
    targetIDs: ['windows', 'mac'],
    pinnedDirectory: null,
    allowedDirectories: null,
  };
  const pairing = store.createPairingCode(scope);

  const result = store.exchangePairingCode(pairing.code, 'Siyu iPhone');
  assert.equal(result.connection.authType, 'bearer');
  assert.equal(result.connection.name, 'Siyu iPhone');
  assert.equal(result.connection.token.length, 64);
  assert.equal(result.client.token, undefined);
  assert.deepEqual(result.client.targetIDs, ['windows', 'mac']);
  assert.equal(store.authenticateBearer(result.connection.token).clientID, result.client.clientID);
  assert.equal(store.authenticateBearer('wrong-token'), null);
  assert.throws(() => store.exchangePairingCode(pairing.code, 'Second phone'), /invalid or already used/i);

  const persisted = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  assert.equal(JSON.stringify(persisted).includes(result.connection.token), false);
  assert.equal(persisted.devices[0].tokenHash.length, 64);

  const reloaded = new PairingStore({
    statePath: store.statePath,
    bootstrapToken: 'bootstrap-secret-with-32-bytes',
  });
  assert.equal(reloaded.authenticateBearer(result.connection.token).clientID, result.client.clientID);

  now += 10 * 365 * 24 * 60 * 60 * 1_000;
  assert.equal(store.authenticateBearer(result.connection.token).clientID, result.client.clientID);
  assert.equal(store.listDevices()[0].displayName, 'Siyu iPhone');
});

test('renames a paired phone without rotating its durable credential', async () => {
  let now = 20_000;
  const store = await fixtureStore({ now: () => now });
  const pairing = store.createPairingCode({
    targetID: 'home',
    targetIDs: ['home'],
    pinnedDirectory: null,
    allowedDirectories: null,
  });
  const issued = store.exchangePairingCode(pairing.code, 'OpenCode iPhone');

  now += 1_000;
  const renamed = store.renameDevice(issued.client.clientID, '  Travel phone  ');
  assert.equal(renamed.displayName, 'Travel phone');
  assert.equal(renamed.displayNameRevision, 2);
  assert.equal(store.authenticateBearer(issued.connection.token).displayName, 'Travel phone');
  assert.equal(store.deviceForClientID(issued.client.clientID).displayName, 'Travel phone');
  assert.throws(() => store.renameDevice(issued.client.clientID, '   '), /must not be empty/i);
  assert.equal(store.renameDevice('missing-phone', 'No device'), null);
});

test('expires pairing codes without issuing a device credential', async () => {
  let now = 50_000;
  const store = await fixtureStore({ now: () => now, pairingTtlMs: 100 });
  const pairing = store.createPairingCode({
    targetID: 'home',
    targetIDs: ['home'],
    pinnedDirectory: null,
    allowedDirectories: null,
  });

  now = 50_101;
  assert.throws(() => store.exchangePairingCode(pairing.code, 'Expired phone'), /expired/i);
  assert.deepEqual(store.listDevices(), []);
});


test('upgrades a tunnel-era state file, dropping machines while keeping the owner and paired devices', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-pairing-legacy-'));
  fixtureDirectories.add(directory);
  const statePath = path.join(directory, 'passkeys.json');

  // Shape written by the relay that still enrolled machines over a tunnel. An
  // existing deployment has exactly this on disk, so the upgrade must not throw
  // and must not cost the owner their credential or their paired phones.
  await fs.writeFile(statePath, JSON.stringify({
    version: 2,
    owner: { userID: 'owner-user-id', userName: 'owner' },
    credentials: [{ id: 'credential-id', publicKey: 'cHVibGlj', counter: 4 }],
    devices: [{
      clientID: 'phone-1',
      displayName: 'iPhone',
      tokenHash: 'a'.repeat(64),
      targetID: 'mac',
      targetIDs: ['mac'],
      pinnedDirectory: null,
      allowedDirectories: null,
    }],
    machines: [{ machineID: 'machine-1', displayName: 'Old MacBook', targetID: 'mac-opencode', port: 4098 }],
  }));

  const store = new PairingStore({ statePath, bootstrapToken: 'bootstrap-secret-with-32-bytes' });

  assert.equal(store.hasCredentials(), true);
  assert.equal(store.listDevices().length, 1);
  assert.equal(store.listDevices()[0].clientID, 'phone-1');
  assert.equal(store.listDevices()[0].tokenHash, undefined);

  store.ensureOwner();
  const persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(persisted.version, 3);
  assert.equal(persisted.machines, undefined);
  assert.equal(persisted.credentials.length, 1);
  assert.equal(persisted.devices.length, 1);
});

test('rejects a state file whose version it does not understand', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-pairing-future-'));
  fixtureDirectories.add(directory);
  const statePath = path.join(directory, 'passkeys.json');
  await fs.writeFile(statePath, JSON.stringify({ version: 99, owner: null, credentials: [], devices: [] }));

  // Silently starting with empty state would drop every paired device, so an
  // unreadable file must surface instead of being treated as a fresh install.
  assert.throws(
    () => new PairingStore({ statePath, bootstrapToken: 'bootstrap-secret-with-32-bytes' }),
    /unsupported passkey state/,
  );
});
