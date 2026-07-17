import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const execute = promisify(execFile);
const macosRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const authClient = path.join(macosRoot, 'opencode-machine-auth.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

test('macOS OAuth client saves one-time machine credentials and generated FRP configuration', async () => {
  const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'opencode-machine-auth-'));
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  const accessToken = 'machine-access-token-with-more-than-thirty-two-characters';
  const requests = [];
  let machineName = 'Test Mac';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/oauth/device/code') {
      res.end(JSON.stringify({
        device_code: 'device-code-with-more-than-twenty-four-characters',
        user_code: 'ABCD-2345',
        verification_uri_complete: 'https://relay.example/?user_code=ABCD-2345',
        expires_in: 60,
        interval: 1,
      }));
      return;
    }
    if (req.url === '/api/oauth/token') {
      res.end(JSON.stringify({
        access_token: accessToken,
        machine: { machineID: 'machine-test', targetID: 'mac-test', displayName: machineName, displayNameRevision: 1, port: 4100 },
        transport: {
          type: 'frp-ssh',
          frpServerHost: '127.0.0.1',
          frpServerPort: 7000,
          frpToken: 'frp-test-secret',
          remotePort: 4100,
          localForwardPort: 17000,
        },
      }));
      return;
    }
    if (req.url === '/api/machine/me' && req.method === 'GET' && req.headers.authorization === `Bearer ${accessToken}`) {
      res.end(JSON.stringify({ machine: { machineID: 'machine-test', targetID: 'mac-test', displayName: machineName, displayNameRevision: machineName === 'Test Mac' ? 1 : 2, port: 4100 } }));
      return;
    }
    if (req.url === '/api/machine/name' && req.headers.authorization === `Bearer ${accessToken}`) {
      machineName = body.displayName;
      res.end(JSON.stringify({ renamed: true, machine: { machineID: 'machine-test', targetID: 'mac-test', displayName: machineName, displayNameRevision: 2, port: 4100 } }));
      return;
    }
    if (req.url === '/api/machine/me' && req.method === 'DELETE' && req.headers.authorization === `Bearer ${accessToken}`) {
      res.end(JSON.stringify({ revoked: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const relayOrigin = `http://127.0.0.1:${server.address().port}`;
  const environment = {
    ...process.env,
    HOME: home,
    OPENCODE_RELAY_CONFIG_DIR: path.join(home, '.config', 'opencode-relay'),
    OPENCODE_MACHINE_CREDENTIAL: path.join(home, '.config', 'opencode-relay', 'machine.json'),
    OPENCODE_FRPC_CONFIG: path.join(home, '.config', 'opencode-relay', 'frpc.toml'),
    OPENCODE_RELAY_ORIGIN: relayOrigin,
    OPENCODE_RELAY_SSH_ALIAS: 'test-vps',
    OPENCODE_RELAY_NO_OPEN: '1',
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_SERVER_PASSWORD: 'local-basic-password-with-enough-entropy',
    OPENCODE_MACHINE_NAME: 'Test Mac',
  };

  const ensured = await execute(process.execPath, [authClient, 'ensure'], { env: environment });
  assert.equal(JSON.parse(ensured.stdout).Status, 'Authorized');
  assert.match(ensured.stderr, /ABCD-2345/);
  assert.equal(ensured.stdout.includes(accessToken), false);

  const configDirectory = path.join(home, '.config', 'opencode-relay');
  const credentialPath = path.join(configDirectory, 'machine.json');
  const credential = JSON.parse(await fs.readFile(credentialPath, 'utf8'));
  assert.equal(credential.accessToken, accessToken);
  assert.equal(credential.sshAlias, 'test-vps');
  assert.equal((await fs.stat(credentialPath)).mode & 0o777, 0o600);
  const frpc = await fs.readFile(path.join(configDirectory, 'frpc.toml'), 'utf8');
  assert.match(frpc, /name = "mac-test"/);
  assert.match(frpc, /remotePort = 4100/);
  assert.match(frpc, /auth\.token = "frp-test-secret"/);
  assert.equal(requests[0].body.basicPassword, 'local-basic-password-with-enough-entropy');

  const status = await execute(process.execPath, [authClient, 'status'], { env: environment });
  assert.equal(JSON.parse(status.stdout).Status, 'Authorized');
  assert.equal(requests.at(-1).authorization, `Bearer ${accessToken}`);

  const renamed = await execute(process.execPath, [authClient, 'rename', 'Studio', 'Mac'], { env: environment });
  assert.equal(JSON.parse(renamed.stdout).Machine.displayName, 'Studio Mac');
  const renamedCredential = JSON.parse(await fs.readFile(credentialPath, 'utf8'));
  assert.equal(renamedCredential.machine.displayName, 'Studio Mac');
  assert.equal(requests.at(-1).body.displayName, 'Studio Mac');

  const revoked = await execute(process.execPath, [authClient, 'revoke'], { env: environment });
  assert.equal(JSON.parse(revoked.stdout).Status, 'Revoked');
  assert.equal(requests.at(-1).authorization, `Bearer ${accessToken}`);
});
