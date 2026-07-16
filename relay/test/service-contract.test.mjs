import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), 'utf8');
}

test('service defines matching credential, reload, and shutdown directives', async () => {
  const service = await read('opencode-relay.service');

  for (const directive of [
    'Environment=TOKENS_PATH=/etc/opencode-relay/tokens.json',
    'Environment=TOKEN_RELOAD_SEC=60',
    'Environment=PASSKEY_STATE_PATH=/etc/opencode-relay/passkeys.json',
    'Environment=FRPS_CONFIG_PATH=/etc/frp/frps.toml',
    'EnvironmentFile=-/etc/opencode-relay/relay.env',
    'UMask=0077',
    'MemoryMax=128M',
    'TimeoutStopSec=30s',
    'ReadWritePaths=/etc/opencode-relay',
  ]) assert.match(service, new RegExp(`^${directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('README documents proxy deployment without sync metadata or route handling', async () => {
  const readme = await read('README.md');

  for (const required of [
    '/etc/opencode-relay',
    'TOKEN_RELOAD_SEC',
    'reverse_proxy 127.0.0.1:4097',
  ]) assert.match(readme, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('relay shutdown closes streams, reload timers, and the HTTP server within a bound', async () => {
  const relay = await read('relay.mjs');

  assert.match(relay, /async function shutdown\(/);
  for (const requiredImport of ['./lib/auth.mjs', './lib/config.mjs', './lib/proxy.mjs']) {
    assert.match(relay, new RegExp(requiredImport.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(relay, /activeStreamsByClient/);
  assert.match(relay, /configReloader\.close\(\)/);
  assert.match(relay, /setTimeout/);
  assert.match(relay, /server\.close/);
});
