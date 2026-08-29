import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const macosRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('macOS installer pins official FRP v0.71.0 Darwin archives and checksums', async () => {
  const installer = await fs.readFile(path.join(macosRoot, 'install.sh'), 'utf8');
  assert.match(installer, /readonly FRP_VERSION="0\.71\.0"/);
  assert.match(installer, /frp_sha256_checksums\.txt/);
  assert.match(installer, /1b1b4e2f1836e21e8733f1dddaacd4ed9ae67d7dbee39046b9d7b7eda6253637/);
  assert.match(installer, /45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6/);
  assert.doesNotMatch(installer, /readonly FRP_VERSION="0\.69\.1"/);
  assert.match(installer, /\[\[ ! -x "\$FRPC_VERSIONED" \]\]/);
  assert.match(installer, /ln -sfn "\$\{FRPC_VERSIONED:t\}" "\$FRPC_LINK"/);
  assert.match(installer, /"\$FRPC_LINK" --version/);
  assert.match(installer, /stale FRPC link|FRPC link is stale/);
});

test('macOS README marks repository ahead of production deployment', async () => {
  const readme = await fs.readFile(path.join(macosRoot, 'README.md'), 'utf8');
  assert.match(readme, /does not deploy or activate it on any Mac/);
  assert.match(readme, /Production Macs remain on/);
});
