export const RELAY_STATUS_KEYS = Object.freeze([
  'checkedAt',
  'publicProbeReachable',
  'publicReachable',
  'probeFailureCount',
  'publicStatus',
]);

export function projectRelayStatus(value) {
  return Object.fromEntries(RELAY_STATUS_KEYS.map((key) => [key, value?.[key] ?? null]));
}
