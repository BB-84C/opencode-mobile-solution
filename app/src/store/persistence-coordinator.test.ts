import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPersistenceCoordinator,
  PersistenceCoordinatorDisposedError,
} from './persistence-coordinator';

describe('persistence coordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces 1000 schedules for one key into the latest snapshot', async () => {
    const writes: Array<{ key: string; snapshot: number }> = [];
    const writer = vi.fn(async (key: string, snapshot: number) => {
      writes.push({ key, snapshot });
    });
    const coordinator = createPersistenceCoordinator(writer, { debounceMs: 40 });

    for (let snapshot = 0; snapshot < 1000; snapshot += 1) {
      coordinator.schedule('transcript:s1', snapshot);
    }

    await vi.advanceTimersByTimeAsync(39);
    expect(writer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await coordinator.flush();

    expect(writes).toEqual([{ key: 'transcript:s1', snapshot: 999 }]);
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it('serializes host and session writers so read-modify-write preserves both', async () => {
    type Snapshot = { value: string };
    let persisted: Record<string, Snapshot> = {};
    let activeWriters = 0;
    let maximumActiveWriters = 0;

    const writer = vi.fn(async (key: string, snapshot: Snapshot) => {
      const beforeWrite = { ...persisted };
      activeWriters += 1;
      maximumActiveWriters = Math.max(maximumActiveWriters, activeWriters);
      await Promise.resolve();
      persisted = { ...beforeWrite, [key]: snapshot };
      activeWriters -= 1;
    });
    const coordinator = createPersistenceCoordinator(writer, { debounceMs: 100 });

    coordinator.schedule('host:macbook', { value: 'host snapshot' });
    coordinator.schedule('session:s1', { value: 'session snapshot' });
    await coordinator.flush();

    expect(maximumActiveWriters).toBe(1);
    expect(persisted).toEqual({
      'host:macbook': { value: 'host snapshot' },
      'session:s1': { value: 'session snapshot' },
    });
    expect(writer).toHaveBeenCalledTimes(2);
  });

  it('continues queued and later writes after a writer failure', async () => {
    const successfulWrites: string[] = [];
    let shouldFail = true;
    const writer = vi.fn(async (key: string, snapshot: string) => {
      if (key === 'host' && shouldFail) {
        shouldFail = false;
        throw new Error('disk unavailable');
      }
      successfulWrites.push(snapshot);
    });
    const coordinator = createPersistenceCoordinator(writer, { debounceMs: 100 });

    coordinator.schedule('host', 'failed host snapshot');
    coordinator.schedule('session', 'session survives');

    await expect(coordinator.flush()).rejects.toThrow('disk unavailable');
    expect(successfulWrites).toEqual(['session survives']);

    coordinator.schedule('host', 'recovered host snapshot');
    await expect(coordinator.flush('host')).resolves.toBeUndefined();

    expect(successfulWrites).toEqual(['session survives', 'recovered host snapshot']);
    expect(writer).toHaveBeenCalledTimes(3);
  });

  it('flushes only the requested key and can cancel the remaining debounce', async () => {
    const writer = vi.fn(async (_key: string, _snapshot: string) => undefined);
    const coordinator = createPersistenceCoordinator(writer, { debounceMs: 10_000 });

    coordinator.schedule('host', 'host snapshot');
    coordinator.schedule('session', 'session snapshot');
    await coordinator.flush('host');

    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenLastCalledWith('host', 'host snapshot');

    await coordinator.dispose('cancel');
    await vi.runAllTimersAsync();

    expect(writer).toHaveBeenCalledTimes(1);
    expect(() => coordinator.schedule('host', 'late snapshot')).toThrow(PersistenceCoordinatorDisposedError);
  });

  it('flushes pending snapshots when disposed in flush mode', async () => {
    const writer = vi.fn(async (_key: string, _snapshot: string) => undefined);
    const coordinator = createPersistenceCoordinator(writer, { debounceMs: 10_000 });

    coordinator.schedule('session', 'final snapshot');
    await coordinator.dispose('flush');

    expect(writer).toHaveBeenCalledOnce();
    expect(writer).toHaveBeenCalledWith('session', 'final snapshot');
    await expect(coordinator.flush()).rejects.toBeInstanceOf(PersistenceCoordinatorDisposedError);
  });
});
