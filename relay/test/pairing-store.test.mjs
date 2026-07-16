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

function machineRequest(overrides = {}) {
  return {
    installationID: 'installation-macbook-1234',
    displayName: 'Siyu MacBook',
    hostname: 'siyu-macbook',
    platform: 'macos',
    clientVersion: '2',
    basicUsername: 'opencode',
    basicPassword: 'local-basic-password-with-enough-entropy',
    requestedTargetID: 'mac-opencode',
    requestedRemotePort: 4098,
    ...overrides,
  };
}

test('upgrades legacy passkey state and persists machines in the new schema', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-pairing-legacy-'));
  fixtureDirectories.add(directory);
  const statePath = path.join(directory, 'passkeys.json');
  await fs.writeFile(statePath, JSON.stringify({ version: 1, owner: null, credentials: [], devices: [] }));
  const store = new PairingStore({ statePath, bootstrapToken: 'bootstrap-secret-with-32-bytes' });

  assert.deepEqual(store.listMachines(), []);
  store.ensureOwner();
  assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).version, 2);
});

test('issues a machine token only after approval and never persists the raw token', async () => {
  let now = 100_000;
  const store = await fixtureStore({ now: () => now, machinePollIntervalMs: 1_000 });
  const grant = store.createMachineAuthorization(machineRequest());

  assert.match(grant.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(store.listPendingMachineAuthorizations()[0].basicPassword, undefined);
  assert.throws(() => store.pollMachineAuthorization(grant.deviceCode), (error) => error.code === 'authorization_pending');

  const approved = store.approveMachineAuthorization(grant.userCode, {
    targetID: 'mac-opencode',
    remotePort: 4098,
    displayTargetName: 'MacBook',
    transport: { type: 'frp-ssh', frpToken: 'server-frp-secret' },
  });
  assert.equal(approved.targetID, 'mac-opencode');
  assert.equal(store.machineTargets()[0].displayName, 'Siyu MacBook');
  now += 1_001;
  const issued = store.pollMachineAuthorization(grant.deviceCode);
  assert.equal(issued.transport.frpToken, 'server-frp-secret');
  assert.equal(store.authenticateMachine(issued.accessToken).machineID, approved.machineID);
  assert.throws(() => store.pollMachineAuthorization(grant.deviceCode), (error) => error.code === 'expired_token');

  const persisted = await fs.readFile(store.statePath, 'utf8');
  assert.equal(persisted.includes(issued.accessToken), false);
  assert.equal(JSON.parse(persisted).machines[0].tokenHash.length, 64);
});

test('records machine heartbeat, exposes proxy credentials only internally, and revokes access', async () => {
  const store = await fixtureStore();
  const grant = store.createMachineAuthorization(machineRequest());
  const machine = store.approveMachineAuthorization(grant.userCode, {
    targetID: 'mac-opencode',
    remotePort: 4098,
    transport: { type: 'frp-ssh', frpToken: 'server-frp-secret' },
  });
  const target = store.machineTargets()[0];

  assert.equal(target.basicPass, 'local-basic-password-with-enough-entropy');
  assert.equal(store.listMachines()[0].basicPass, undefined);
  const heartbeat = store.updateMachineHeartbeat(machine.machineID, {
    localHealth: true,
    opencodeVersion: '1.17.18',
    controllerVersion: '2',
  });
  assert.equal(heartbeat.heartbeat.lifecycle, 'running');
  assert.equal(heartbeat.heartbeat.localHealth, true);
  const stopped = store.updateMachineHeartbeat(machine.machineID, {
    lifecycle: 'stopped',
    localHealth: false,
    opencodeVersion: '1.17.18',
    controllerVersion: '2',
  });
  assert.equal(stopped.heartbeat.lifecycle, 'stopped');
  assert.equal(store.revokeMachine(machine.machineID), true);
  assert.deepEqual(store.machineTargets(), []);
  assert.equal(store.listMachines()[0].revokedAt !== null, true);
});

test('renames a machine across dashboard, discovery, and machine identity without rotating routing', async () => {
  let now = 300_000;
  const store = await fixtureStore({ now: () => now, machinePollIntervalMs: 1 });
  const grant = store.createMachineAuthorization(machineRequest());
  const approved = store.approveMachineAuthorization(grant.userCode, {
    targetID: 'mac-opencode',
    remotePort: 4098,
    displayTargetName: 'MacBook',
    transport: { type: 'frp-ssh', frpToken: 'server-frp-secret' },
  });
  now += 2;
  const issued = store.pollMachineAuthorization(grant.deviceCode);

  now += 1_000;
  const renamed = store.renameMachine(approved.machineID, '  Studio Mac  ');
  assert.equal(renamed.displayName, 'Studio Mac');
  assert.equal(renamed.displayNameRevision, 2);
  assert.deepEqual(
    store.machineTargets().map(({ targetID, displayName, port }) => ({ targetID, displayName, port })),
    [{ targetID: 'mac-opencode', displayName: 'Studio Mac', port: 4098 }],
  );
  assert.equal(store.authenticateMachine(issued.accessToken).displayName, 'Studio Mac');
  assert.throws(() => store.renameMachine(approved.machineID, '\n\t'), /must not be empty/i);
  assert.equal(store.renameMachine('missing-machine', 'No machine'), null);
});

test('migrates a legacy split Dashboard/discovery name to the canonical Dashboard name', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-pairing-split-name-'));
  fixtureDirectories.add(directory);
  const statePath = path.join(directory, 'passkeys.json');
  await fs.writeFile(statePath, JSON.stringify({
    version: 2,
    owner: null,
    credentials: [],
    devices: [],
    machines: [{
      machineID: 'machine-legacy-windows',
      installationID: 'installation-windows-legacy',
      displayName: 'Woody',
      displayTargetName: 'Windows workstation',
      displayNameRevision: null,
      displayNameUpdatedAt: null,
      targetID: 'home-opencode',
      host: '127.0.0.1',
      port: 4096,
      basicUser: 'opencode',
      basicPass: 'legacy-basic-password',
      authorizedAt: '2026-07-14T17:18:45.299Z',
      revokedAt: null,
    }],
  }));

  const store = new PairingStore({ statePath, bootstrapToken: 'bootstrap-secret-with-32-bytes' });
  const machine = store.listMachines()[0];
  assert.equal(machine.displayName, 'Woody');
  assert.equal(machine.displayTargetName, 'Woody');
  assert.equal(machine.displayNameRevision, 1);
  assert.equal(machine.displayNameUpdatedAt, machine.authorizedAt);
  assert.equal(store.machineTargets()[0].displayName, 'Woody');

  const persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(persisted.machines[0].displayName, 'Woody');
  assert.equal(persisted.machines[0].displayTargetName, 'Woody');
  assert.equal(persisted.machines[0].displayNameRevision, 1);
  assert.equal(persisted.machines[0].displayNameUpdatedAt, machine.authorizedAt);
});
