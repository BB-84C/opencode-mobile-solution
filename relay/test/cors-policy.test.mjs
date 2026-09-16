import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  ALLOWED_METHODS,
  ALLOWED_REQUEST_HEADERS,
  EXPOSED_RESPONSE_HEADERS,
  preflightHeaders,
  responseHeaders,
} from '../lib/cors.mjs';

const relayRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(relayRoot);

const read = (relative) => fs.readFile(path.join(repoRoot, relative), 'utf8');

test('every custom header the client sends is allowed, and every one it reads is exposed', async () => {
  // This is the test that was missing. The desktop app sends X-OpenCode-Target
  // and X-OpenCode-Directory; the relay allowed neither, so the browser blocked
  // the request before it was sent and the app reported "Failed to fetch" with
  // no indication that the relay had a policy at all.
  const client = await read('app/src/opencode/client.ts');
  const used = new Set([...client.matchAll(/['"](X-[A-Za-z0-9-]+)['"]/g)].map((match) => match[1]));

  assert.ok(used.size > 0, 'found no custom headers in the client; the pattern probably broke');

  const known = new Set([...ALLOWED_REQUEST_HEADERS, ...EXPOSED_RESPONSE_HEADERS]
    .map((header) => header.toLowerCase()));
  for (const header of used) {
    assert.ok(
      known.has(header.toLowerCase()),
      `the client uses ${header} but the relay neither allows nor exposes it`,
    );
  }
});

test('nothing answers a preflight with its own hand-written policy', async () => {
  // Two places reply to OPTIONS. When one of them spelled out a narrower list of
  // its own, it shadowed the other for every /api/ route, and a shell client
  // could not see the difference because curl does not enforce CORS.
  for (const file of ['relay/relay.mjs', 'relay/lib/passkey-pairing.mjs', 'relay/lib/proxy.mjs']) {
    const source = await read(file);

    assert.ok(
      !/['"]Access-Control-Allow-Headers['"]/i.test(source),
      `${file} spells out its own allowed headers; it should call preflightHeaders()`,
    );
  }
});

test('the preflight advertises every method the client can issue', () => {
  const advertised = preflightHeaders()['Access-Control-Allow-Methods'].split(',');

  assert.deepEqual(advertised, ALLOWED_METHODS);
  // PATCH was dropped once by a hand-written copy of this list.
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.ok(advertised.includes(method), `${method} is missing from the preflight`);
  }
});

test('a preflight and an ordinary response agree about what is readable', () => {
  assert.equal(
    preflightHeaders()['Access-Control-Expose-Headers'],
    responseHeaders()['Access-Control-Expose-Headers'],
  );
});

test('the paging cursor is readable, or the session list silently stops at one page', () => {
  assert.ok(
    EXPOSED_RESPONSE_HEADERS.some((header) => header.toLowerCase() === 'x-next-cursor'),
    'X-Next-Cursor must be exposed',
  );
});
