const RELAY_STATUS_KEYS = Object.freeze([
  'checkedAt',
  'publicProbeReachable',
  'publicReachable',
  'probeFailureCount',
  'publicStatus',
]);

export function emptyRelayStatus() {
  return {
    checkedAt: null,
    publicProbeReachable: null,
    publicReachable: null,
    probeFailureCount: null,
    publicStatus: null,
  };
}

export function projectRelayStatus(value) {
  const projected = emptyRelayStatus();
  for (const key of RELAY_STATUS_KEYS) projected[key] = value?.[key] ?? null;
  return projected;
}

export function createMachineStatusMonitor({
  getTargets,
  probeTarget,
  intervalMs = 10_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => new Date(),
  onError = () => {},
}) {
  const cache = new Map();
  let timer = null;
  let inFlight = false;
  let closed = false;

  async function refresh() {
    if (closed || inFlight) return false;
    inFlight = true;
    try {
      const targets = getTargets();
      for (const targetID of cache.keys()) {
        if (!targets.has(targetID)) cache.delete(targetID);
      }
      await Promise.all([...targets].map(async ([targetID, target]) => {
        let result;
        try {
          result = await probeTarget(target);
        } catch {
          result = { reachable: false, statusCode: null };
        }
        const previousFailures = cache.get(targetID)?.probeFailureCount ?? 0;
        const probeFailureCount = result.reachable ? 0 : previousFailures + 1;
        cache.set(targetID, {
          checkedAt: now().toISOString(),
          publicProbeReachable: result.reachable === true,
          publicReachable: result.reachable === true || probeFailureCount < 2,
          probeFailureCount,
          publicStatus: result.statusCode ?? null,
        });
      }));
      return true;
    } finally {
      inFlight = false;
    }
  }

  async function start() {
    if (closed) return false;
    if (timer === null) {
      timer = setIntervalFn(() => {
        void refresh().catch(onError);
      }, intervalMs);
    }
    return refresh().catch((error) => {
      onError(error);
      return false;
    });
  }

  function getStatus(targetID) {
    return projectRelayStatus(cache.get(targetID));
  }

  function close() {
    closed = true;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
  }

  return { start, refresh, getStatus, close };
}
