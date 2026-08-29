import assert from 'node:assert/strict';
import { test } from 'node:test';

import { projectRelayStatus, RELAY_STATUS_KEYS } from '../relay-status-contract.mjs';

test('agent relay status projection has the exact allowlist and nulls missing fields', () => {
  const projected = projectRelayStatus({
    checkedAt: '2026-08-29T12:00:00.000Z',
    publicProbeReachable: true,
    publicReachable: true,
    probeFailureCount: 0,
    publicStatus: 200,
    accessToken: 'sentinel-secret',
  });
  assert.deepEqual(Object.keys(projected), RELAY_STATUS_KEYS);
  assert.equal(JSON.stringify(projected).includes('sentinel-secret'), false);
  assert.deepEqual(projectRelayStatus({}), Object.fromEntries(RELAY_STATUS_KEYS.map((key) => [key, null])));
});
