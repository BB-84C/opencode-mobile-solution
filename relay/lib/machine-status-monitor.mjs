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
  probeDeadlineMs = 8_000,
  roundDeadlineMs = 9_000,
  cacheMaxAgeMs = intervalMs * 3,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => new Date(),
  onError = () => {},
}) {
  const cache = new Map();
  const activeControllers = new Set();
  let timer = null;
  let inFlight = false;
  let closed = false;

  const failedProbe = () => ({ reachable: false, statusCode: null });

  async function boundedProbe(targetID, target) {
    const controller = new AbortController();
    activeControllers.add(controller);
    let deadline = null;
    try {
      const result = await Promise.race([
        Promise.resolve()
          .then(() => probeTarget(target, { signal: controller.signal }))
          .then((value) => value ?? failedProbe(), failedProbe),
        new Promise((resolve) => {
          deadline = setTimeoutFn(() => {
            controller.abort(new Error('target probe deadline expired'));
            resolve(failedProbe());
          }, probeDeadlineMs);
        }),
      ]);
      return [targetID, result];
    } finally {
      if (deadline !== null) clearTimeoutFn(deadline);
      activeControllers.delete(controller);
    }
  }

  async function refresh() {
    if (closed || inFlight) return false;
    inFlight = true;
    try {
      const targets = getTargets();
      for (const targetID of cache.keys()) {
        if (!targets.has(targetID)) cache.delete(targetID);
      }
      const entries = [...targets];
      let roundDeadline = null;
      const results = await Promise.race([
        Promise.all(entries.map(([targetID, target]) => boundedProbe(targetID, target))),
        new Promise((resolve) => {
          roundDeadline = setTimeoutFn(() => {
            for (const controller of activeControllers) controller.abort(new Error('target monitor round deadline expired'));
            resolve(entries.map(([targetID]) => [targetID, failedProbe()]));
          }, roundDeadlineMs);
        }),
      ]);
      if (roundDeadline !== null) clearTimeoutFn(roundDeadline);
      if (closed) return false;
      for (const [targetID, result] of results) {
        const previousFailures = cache.get(targetID)?.probeFailureCount ?? 0;
        const probeFailureCount = result.reachable ? 0 : previousFailures + 1;
        cache.set(targetID, {
          checkedAt: now().toISOString(),
          publicProbeReachable: result.reachable === true,
          publicReachable: result.reachable === true || probeFailureCount < 2,
          probeFailureCount,
          publicStatus: result.statusCode ?? null,
        });
      }
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
    const value = cache.get(targetID);
    const checkedAt = Date.parse(value?.checkedAt ?? '');
    const ageMs = now().getTime() - checkedAt;
    if (!Number.isFinite(checkedAt) || ageMs < -5_000 || ageMs > cacheMaxAgeMs) return emptyRelayStatus();
    return projectRelayStatus(value);
  }

  function close() {
    closed = true;
    for (const controller of activeControllers) controller.abort(new Error('target monitor closed'));
    activeControllers.clear();
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
  }

  return { start, refresh, getStatus, close };
}
