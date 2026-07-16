import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { authenticateBearer, resolveScope } from '../lib/auth.mjs';
import { loadConfigSnapshot, startConfigReloader } from '../lib/config.mjs';

const fixtureDirectories = new Set();

async function writeFixture(config) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-relay-config-'));
  fixtureDirectories.add(directory);
  const tokensPath = path.join(directory, 'tokens.json');
  await fs.writeFile(tokensPath, JSON.stringify(config));
  return tokensPath;
}

function defaultTarget() {
  return { host: '127.0.0.1', port: 4096 };
}

function v2Config(overrides = {}) {
  return {
    version: 2,
    targets: {
      home: {
        host: '127.0.0.1',
        port: 4096,
        basicUser: 'opencode',
        basicPass: 'basic-secret',
      },
    },
    clients: {
      owner: {
        clientID: 'owner',
        displayName: 'Overseer Phone',
        token: 'owner-token',
        targetID: 'home',
        pinnedDirectory: null,
        allowedDirectories: null,
      },
    },
    ...overrides,
  };
}

after(async () => {
  await Promise.all([...fixtureDirectories].map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

test('migrates the legacy tokens shape into v2 client and target maps', async () => {
  const tokensPath = await writeFixture({
    tokens: {
      phone: {
        token: 'phone-token',
        name: 'Primary Phone',
        basic_user: 'opencode',
        basic_pass: 'legacy-secret',
        directory: '/vault/project',
      },
    },
  });

  const snapshot = loadConfigSnapshot({ tokensPath, defaultTarget: defaultTarget() });
  const client = snapshot.clients.get('phone');
  const target = snapshot.targets.get(client.targetID);

  assert.equal(snapshot.version, 2);
  assert.equal(client.clientID, 'phone');
  assert.equal(client.displayName, 'Primary Phone');
  assert.equal(client.pinnedDirectory, '/vault/project');
  assert.equal(target.host, '127.0.0.1');
  assert.equal(target.basicPass, 'legacy-secret');
});

test('parses v2 targets and keeps clientID stable when displayName changes', async () => {
  const tokensPath = await writeFixture(v2Config());
  const snapshot = loadConfigSnapshot({ tokensPath, defaultTarget: defaultTarget() });
  const client = snapshot.clients.get('owner');

  assert.equal(snapshot.targets.get('home').basicUser, 'opencode');
  assert.equal(client.clientID, 'owner');
  assert.equal(client.displayName, 'Overseer Phone');
  assert.equal(authenticateBearer(snapshot, 'owner-token').clientID, 'owner');
});

test('authorizes one owner token for multiple explicitly named relay targets', async () => {
  const config = v2Config({
    targets: {
      home: {
        displayName: 'Windows workstation',
        host: '127.0.0.1',
        port: 4096,
        basicUser: 'opencode',
        basicPass: 'home-secret',
      },
      mac: {
        displayName: 'MacBook',
        host: '127.0.0.1',
        port: 4098,
        basicUser: 'opencode',
        basicPass: 'mac-secret',
      },
    },
    clients: {
      owner: {
        clientID: 'owner',
        displayName: 'Owner iPhone',
        token: 'owner-token',
        targetID: 'home',
        targetIDs: ['home', 'mac'],
        pinnedDirectory: null,
        allowedDirectories: null,
      },
    },
  });
  const snapshot = loadConfigSnapshot({ tokensPath: await writeFixture(config), defaultTarget: defaultTarget() });
  const owner = snapshot.clients.get('owner');

  assert.deepEqual(owner.targetIDs, ['home', 'mac']);
  assert.equal(snapshot.targets.get('home').displayName, 'Windows workstation');
  assert.deepEqual(resolveScope(owner, '/Users/example', 'mac'), {
    ok: true,
    targetID: 'mac',
    directory: '/Users/example',
  });
  assert.deepEqual(resolveScope(owner, undefined, 'not-authorized'), {
    ok: false,
    error: 'target_forbidden',
  });
});

test('accepts canonical Windows backend directories in relay configuration', async () => {
  const windowsDirectory = 'D:\\workspace\\project';
  const config = v2Config();
  config.clients.owner.pinnedDirectory = windowsDirectory;
  const tokensPath = await writeFixture(config);
  const client = loadConfigSnapshot({ tokensPath, defaultTarget: defaultTarget() }).clients.get('owner');

  assert.equal(client.pinnedDirectory, windowsDirectory);
});

test('retains the last valid snapshot when a hot reload is malformed', async (t) => {
  const tokensPath = await writeFixture(v2Config());
  const reloader = startConfigReloader({ tokensPath, defaultTarget: defaultTarget(), reloadSec: 3600 });
  t.after(() => reloader.close());
  const original = reloader.getSnapshot();
  await fs.writeFile(tokensPath, '{not-json');

  assert.equal(reloader.reload(), false);
  assert.equal(reloader.getSnapshot(), original);
  assert.equal(authenticateBearer(reloader.getSnapshot(), 'owner-token').clientID, 'owner');
});

test('fails closed when any configured client lacks a bearer token or Basic password', async () => {
  const missingToken = await writeFixture({
    tokens: { phone: { basic_user: 'opencode', basic_pass: 'secret' } },
  });
  const missingPassword = await writeFixture({
    tokens: { phone: { token: 'phone-token', basic_user: 'opencode' } },
  });

  assert.throws(() => loadConfigSnapshot({ tokensPath: missingToken, defaultTarget: defaultTarget() }));
  assert.throws(() => loadConfigSnapshot({ tokensPath: missingPassword, defaultTarget: defaultTarget() }));
});

test('uses timing-safe bearer comparison and rejects unequal lengths', async () => {
  const tokensPath = await writeFixture(v2Config());
  const snapshot = loadConfigSnapshot({ tokensPath, defaultTarget: defaultTarget() });

  assert.equal(authenticateBearer(snapshot, 'owner-token').clientID, 'owner');
  assert.equal(authenticateBearer(snapshot, 'owner-toke'), null);
  assert.equal(authenticateBearer(snapshot, 'wrong-token'), null);
});

test('removes legacy incoming directories unless the token pins one', async () => {
  const tokensPath = await writeFixture({
    tokens: {
      client: { token: 'client-token', basic_pass: 'secret', directory: null },
      pinned: { token: 'pinned-token', basic_pass: 'secret', directory: '/vault/pinned' },
    },
  });
  const snapshot = loadConfigSnapshot({ tokensPath, defaultTarget: defaultTarget() });

  assert.deepEqual(resolveScope(snapshot.clients.get('client'), '/client/supplied'), {
    ok: true,
    targetID: 'legacy:client',
    directory: undefined,
  });
  assert.deepEqual(resolveScope(snapshot.clients.get('pinned'), '/client/supplied'), {
    ok: true,
    targetID: 'legacy:pinned',
    directory: '/vault/pinned',
  });
});

test('allows an unrestricted owner to supply only a canonical absolute directory', async () => {
  const tokensPath = await writeFixture(v2Config());
  const owner = loadConfigSnapshot({ tokensPath, defaultTarget: defaultTarget() }).clients.get('owner');

  assert.deepEqual(resolveScope(owner, '/vault/owner-project'), {
    ok: true,
    targetID: 'home',
    directory: '/vault/owner-project',
  });
  assert.deepEqual(resolveScope(owner, '/vault/owner/../other'), {
    ok: false,
    error: 'directory_forbidden',
  });
  assert.deepEqual(resolveScope(owner, 'D:\\workspace\\project'), {
    ok: true,
    targetID: 'home',
    directory: 'D:\\workspace\\project',
  });
  assert.deepEqual(resolveScope(owner, 'D:\\workspace\\tools\\..\\other'), {
    ok: false,
    error: 'directory_forbidden',
  });
});

test('rejects a directory outside a client allowlist', async () => {
  const tokensPath = await writeFixture(v2Config({
    clients: {
      restricted: {
        clientID: 'restricted',
        displayName: 'Restricted',
        token: 'restricted-token',
        targetID: 'home',
        pinnedDirectory: null,
        allowedDirectories: ['/vault/allowed'],
      },
    },
  }));
  const restricted = loadConfigSnapshot({ tokensPath, defaultTarget: defaultTarget() }).clients.get('restricted');

  assert.deepEqual(resolveScope(restricted, '/vault/disallowed'), {
    ok: false,
    error: 'directory_forbidden',
  });
});
