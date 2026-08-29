import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const execute = promisify(execFile);
const macosRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installer = path.join(macosRoot, 'install.sh');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function run(file, args, environment) {
  try {
    const result = await execute(file, args, { env: environment });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('installer atomically wraps, updates, diagnoses, and restores the original OpenCode entry', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-macos-install-'));
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  const bin = path.join(home, '.local', 'bin');
  await fs.mkdir(bin, { recursive: true });
  const wrapper = path.join(bin, 'opencode');
  const original = `#!/bin/zsh
printf 'real:%s|username=%s\\n' "$*" "\${OPENCODE_SERVER_USERNAME:-unset}"
`;
  await fs.writeFile(wrapper, original, { mode: 0o755 });
  const frpc = path.join(home, 'frpc');
  await fs.writeFile(frpc, '#!/bin/zsh\nprintf "0.71.0\\n"\n', { mode: 0o755 });
  const environment = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
  };

  const installed = await run('/bin/zsh', [
    installer,
    'install',
    '--relay-origin', 'https://relay.example',
    '--ssh-alias', 'test-vps',
    '--node', process.execPath,
    '--opencode', wrapper,
    '--frpc', frpc,
  ], environment);
  assert.equal(installed.code, 0, installed.stderr);

  const rendered = await fs.readFile(wrapper, 'utf8');
  assert.match(rendered, /opencode-relay-managed-wrapper v1/);
  assert.doesNotMatch(rendered, /__OPENCODE_REAL_CMD__/);
  const config = path.join(home, '.config', 'opencode-relay');
  const metadataPath = path.join(config, 'installation.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  assert.equal((await fs.stat(metadataPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(config, 'env'))).mode & 0o777, 0o600);
  assert.ok(metadata.previousEntryBackup);
  assert.equal(await fs.readFile(metadata.previousEntryBackup, 'utf8'), original);

  const local = await run(wrapper, ['--local', '--version'], {
    ...environment,
    OPENCODE_SERVER_USERNAME: 'must-not-leak',
  });
  assert.equal(local.code, 0, local.stderr);
  assert.equal(local.stdout.trim(), 'real:--version|username=unset');

  const passthrough = await run(wrapper, ['auth', 'list'], {
    ...environment,
    OPENCODE_SERVER_USERNAME: 'must-not-leak',
  });
  assert.equal(passthrough.code, 0, passthrough.stderr);
  assert.equal(passthrough.stdout.trim(), 'real:auth list|username=unset');

  const environmentBeforeUpdate = await fs.readFile(path.join(config, 'env'), 'utf8');
  const frpcDirectory = path.join(home, '.local', 'lib', 'opencode-relay', 'bin');
  const frpcLink = path.join(frpcDirectory, 'frpc');
  const staleFrpc = path.join(frpcDirectory, 'frpc-0.69.1');
  await fs.writeFile(staleFrpc, '#!/bin/zsh\nprintf "0.69.1\\n"\n', { mode: 0o755 });
  await fs.rm(frpcLink);
  await fs.symlink(path.basename(staleFrpc), frpcLink);
  const updated = await run('/bin/zsh', [
    installer,
    'update',
    '--node', process.execPath,
  ], environment);
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal(await fs.readFile(path.join(config, 'env'), 'utf8'), environmentBeforeUpdate);
  assert.equal(await fs.realpath(frpcLink), path.join(frpcDirectory, 'frpc-0.71.0'));

  const diagnosed = await run('/bin/zsh', [installer, 'doctor'], environment);
  assert.equal(diagnosed.code, 0, diagnosed.stderr);
  assert.match(diagnosed.stdout, /installation: OK/);
  assert.match(diagnosed.stdout, /FRPC linked artifact: .*version 0\.71\.0/);

  await fs.writeFile(path.join(frpcDirectory, 'frpc-0.71.0'), '#!/bin/zsh\nprintf "0.69.1\\n"\n', { mode: 0o755 });
  const staleDoctor = await run('/bin/zsh', [installer, 'doctor'], environment);
  assert.equal(staleDoctor.code, 10);
  assert.match(staleDoctor.stderr, /stale version: 0\.69\.1/);
  await fs.writeFile(path.join(frpcDirectory, 'frpc-0.71.0'), '#!/bin/zsh\nprintf "0.71.0\\n"\n', { mode: 0o755 });

  const uninstalled = await run('/bin/zsh', [installer, 'uninstall'], environment);
  assert.equal(uninstalled.code, 0, uninstalled.stderr);
  assert.equal(await fs.readFile(wrapper, 'utf8'), original);
  await assert.rejects(fs.access(metadataPath));
  assert.equal(await fs.readFile(path.join(config, 'env'), 'utf8'), environmentBeforeUpdate);
});
