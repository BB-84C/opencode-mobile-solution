import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMachineStatusMonitor } from '../lib/machine-status-monitor.mjs';

const target = { host: '127.0.0.1', port: 1, basicUser: 'test', basicPass: 'sentinel-secret' };

test('fixed monitor owns probes while dashboard readers only consume cached state', async () => {
  let probes = 0;
  let scheduled;
  let cleared = false;
  const monitor = createMachineStatusMonitor({
    getTargets: () => new Map([['desk', target]]),
    probeTarget: async () => { probes += 1; return { reachable: true, statusCode: 200 }; },
    setIntervalFn: (callback, interval) => { scheduled = { callback, interval }; return 42; },
    clearIntervalFn: (handle) => { assert.equal(handle, 42); cleared = true; },
    now: () => new Date('2026-08-29T12:00:00.000Z'),
  });

  await monitor.start();
  assert.equal(scheduled.interval, 10_000);
  assert.equal(probes, 1, 'start performs the immediate first refresh');
  for (let reader = 0; reader < 20; reader += 1) monitor.getStatus('desk');
  assert.equal(probes, 1, 'reader count does not affect probe count');
  await scheduled.callback();
  assert.equal(probes, 2);
  monitor.close();
  assert.equal(cleared, true);
});

test('monitor skips ticks while a round is in flight and applies two-failure debounce', async () => {
  const results = [];
  let release;
  let first = true;
  let clock = new Date('2026-08-29T12:00:00.000Z');
  const firstProbe = new Promise((resolve) => { release = resolve; });
  const monitor = createMachineStatusMonitor({
    getTargets: () => new Map([['desk', target]]),
    probeTarget: async () => {
      if (first) { first = false; return firstProbe; }
      return results.shift();
    },
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    now: () => clock,
  });

  const initial = monitor.start();
  assert.equal(await monitor.refresh(), false, 'overlapping refresh is skipped');
  release({ reachable: true, statusCode: 200 });
  await initial;
  assert.equal(monitor.getStatus('desk').publicReachable, true);

  clock = new Date('2026-08-29T12:00:01.000Z');
  results.push({ reachable: false, statusCode: null });
  await monitor.refresh();
  assert.deepEqual(monitor.getStatus('desk'), {
    checkedAt: '2026-08-29T12:00:01.000Z',
    publicProbeReachable: false,
    publicReachable: true,
    probeFailureCount: 1,
    publicStatus: null,
  });
  clock = new Date('2026-08-29T12:00:02.000Z');
  results.push({ reachable: false, statusCode: 503 });
  await monitor.refresh();
  assert.equal(monitor.getStatus('desk').publicReachable, false);
  assert.equal(monitor.getStatus('desk').probeFailureCount, 2);
  clock = new Date('2026-08-29T12:00:03.000Z');
  results.push({ reachable: true, statusCode: 200 });
  await monitor.refresh();
  assert.equal(monitor.getStatus('desk').publicProbeReachable, true);
  assert.equal(monitor.getStatus('desk').publicReachable, true);
  assert.equal(monitor.getStatus('desk').probeFailureCount, 0);
});

test('monitor prunes removed targets and catches scheduled refresh rejection', async () => {
  let targets = new Map([['desk', target]]);
  let scheduled;
  const errors = [];
  const monitor = createMachineStatusMonitor({
    getTargets: () => targets,
    probeTarget: async () => ({ reachable: true, statusCode: 200 }),
    setIntervalFn: (callback) => { scheduled = callback; return 1; },
    clearIntervalFn: () => {},
    onError: (error) => errors.push(error.message),
  });
  await monitor.start();
  assert.equal(monitor.getStatus('desk').publicProbeReachable, true);

  targets = new Map();
  await monitor.refresh();
  assert.deepEqual(monitor.getStatus('desk'), {
    checkedAt: null,
    publicProbeReachable: null,
    publicReachable: null,
    probeFailureCount: null,
    publicStatus: null,
  });

  targets = null;
  scheduled();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['targets is not iterable']);
  monitor.close();
});

test('monitor catches an immediate start rejection', async () => {
  const errors = [];
  const monitor = createMachineStatusMonitor({
    getTargets: () => { throw new Error('initial registry failure'); },
    probeTarget: async () => ({ reachable: true, statusCode: 200 }),
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    onError: (error) => errors.push(error.message),
  });
  assert.equal(await monitor.start(), false);
  assert.deepEqual(errors, ['initial registry failure']);
  monitor.close();
});

test('never-settling probe is failed by deadline and a later tick still progresses', async () => {
  let probes = 0;
  let mode = 'hang';
  const monitor = createMachineStatusMonitor({
    getTargets: () => new Map([['desk', target]]),
    probeTarget: async (_target, { signal }) => {
      probes += 1;
      if (mode === 'success') return { reachable: true, statusCode: 200 };
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    probeDeadlineMs: 15,
    roundDeadlineMs: 25,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  assert.equal(await monitor.start(), true);
  assert.equal(probes, 1);
  assert.equal(monitor.getStatus('desk').publicProbeReachable, false);
  assert.equal(monitor.getStatus('desk').probeFailureCount, 1);

  mode = 'success';
  assert.equal(await monitor.refresh(), true, 'deadline released the in-flight round');
  assert.equal(probes, 2);
  assert.equal(monitor.getStatus('desk').publicProbeReachable, true);
  assert.equal(monitor.getStatus('desk').probeFailureCount, 0);
  monitor.close();
});

test('round deadline aborts outstanding probes independently of probe deadline', async () => {
  let aborted = false;
  const monitor = createMachineStatusMonitor({
    getTargets: () => new Map([['desk', target]]),
    probeTarget: async (_target, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
    probeDeadlineMs: 100,
    roundDeadlineMs: 15,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  assert.equal(await monitor.start(), true);
  assert.equal(aborted, true);
  assert.equal(monitor.getStatus('desk').publicProbeReachable, false);
  monitor.close();
});

test('cache read fails closed after relay-clock freshness expires', async () => {
  let clock = new Date('2026-08-29T12:00:00.000Z');
  const monitor = createMachineStatusMonitor({
    getTargets: () => new Map([['desk', target]]),
    probeTarget: async () => ({ reachable: true, statusCode: 200 }),
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    now: () => clock,
  });
  await monitor.start();
  assert.equal(monitor.getStatus('desk').publicProbeReachable, true);
  clock = new Date('2026-08-29T12:00:29.999Z');
  assert.equal(monitor.getStatus('desk').publicProbeReachable, true);
  clock = new Date('2026-08-29T12:00:30.001Z');
  assert.deepEqual(monitor.getStatus('desk'), {
    checkedAt: null,
    publicProbeReachable: null,
    publicReachable: null,
    probeFailureCount: null,
    publicStatus: null,
  });
  monitor.close();
});
