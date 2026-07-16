export type PersistenceWriter<Key, Snapshot> = (key: Key, snapshot: Snapshot) => void | Promise<void>;

export interface PersistenceTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PersistenceCoordinatorOptions {
  debounceMs?: number;
  timer?: PersistenceTimer;
}

export type PersistenceDisposeMode = 'flush' | 'cancel';

interface FlushWaiter {
  version: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface KeyState<Snapshot> {
  latestSnapshot: Snapshot;
  latestVersion: number;
  timerHandle: unknown;
  timerScheduled: boolean;
  ready: boolean;
  queued: boolean;
  writingVersion?: number;
  waiters: Set<FlushWaiter>;
}

const defaultTimer: PersistenceTimer = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export class PersistenceCoordinatorDisposedError extends Error {
  constructor() {
    super('Persistence coordinator has been disposed.');
    this.name = 'PersistenceCoordinatorDisposedError';
  }
}

/**
 * Coalesces debounced snapshots per key while serializing every writer call.
 *
 * Serializing writers is important when each writer performs a read-modify-write
 * against the same backing document. A newer snapshot scheduled while its key is
 * being written is retained as a separate, later version.
 */
export class PersistenceCoordinator<Key, Snapshot> {
  private readonly debounceMs: number;
  private readonly timer: PersistenceTimer;
  private readonly states = new Map<Key, KeyState<Snapshot>>();
  private readonly readyQueue: Key[] = [];

  private acceptingSchedules = true;
  private cancelled = false;
  private nextVersion = 0;
  private pumpPromise: Promise<void> | undefined;
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly writer: PersistenceWriter<Key, Snapshot>,
    options: PersistenceCoordinatorOptions = {},
  ) {
    const debounceMs = options.debounceMs ?? 250;
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new RangeError('debounceMs must be a finite, non-negative number.');
    }

    this.debounceMs = debounceMs;
    this.timer = options.timer ?? defaultTimer;
  }

  schedule(key: Key, snapshot: Snapshot): void {
    if (!this.acceptingSchedules) {
      throw new PersistenceCoordinatorDisposedError();
    }

    const version = ++this.nextVersion;
    let state = this.states.get(key);
    if (state) {
      this.clearTimer(state);
      state.latestSnapshot = snapshot;
      state.latestVersion = version;
      state.ready = false;
    } else {
      state = {
        latestSnapshot: snapshot,
        latestVersion: version,
        timerHandle: undefined,
        timerScheduled: false,
        ready: false,
        queued: false,
        waiters: new Set(),
      };
      this.states.set(key, state);
    }

    this.scheduleTimer(key, state, version);
  }

  flush(): Promise<void>;
  flush(key: Key): Promise<void>;
  async flush(key?: Key): Promise<void> {
    if (this.cancelled) {
      throw new PersistenceCoordinatorDisposedError();
    }

    const keys = arguments.length === 0 ? [...this.states.keys()] : [key as Key];
    const results = await Promise.allSettled(keys.map((pendingKey) => this.flushKey(pendingKey)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
  }

  /**
   * Stops accepting schedules. `flush` persists pending snapshots first, while
   * `cancel` drops snapshots that have not started writing. An in-flight writer
   * cannot be cancelled and is awaited in either mode.
   */
  dispose(mode: PersistenceDisposeMode = 'flush'): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.acceptingSchedules = false;
    this.disposePromise = this.performDispose(mode);
    return this.disposePromise;
  }

  private scheduleTimer(key: Key, state: KeyState<Snapshot>, version: number): void {
    state.timerScheduled = true;
    try {
      state.timerHandle = this.timer.setTimeout(() => {
        if (
          this.cancelled ||
          !state.timerScheduled ||
          this.states.get(key) !== state ||
          state.latestVersion !== version
        ) {
          return;
        }

        state.timerScheduled = false;
        state.timerHandle = undefined;
        state.ready = true;
        this.enqueue(key, state);
      }, this.debounceMs);
    } catch (error) {
      state.timerScheduled = false;
      state.timerHandle = undefined;
      throw error;
    }
  }

  private clearTimer(state: KeyState<Snapshot>): void {
    if (!state.timerScheduled) {
      return;
    }

    this.timer.clearTimeout(state.timerHandle);
    state.timerScheduled = false;
    state.timerHandle = undefined;
  }

  private flushKey(key: Key): Promise<void> {
    const state = this.states.get(key);
    if (!state) {
      return Promise.resolve();
    }

    const version = state.latestVersion;
    const completion = new Promise<void>((resolve, reject) => {
      state.waiters.add({ version, resolve, reject });
    });

    if (state.writingVersion === undefined || state.writingVersion < version) {
      this.clearTimer(state);
      state.ready = true;
      this.enqueue(key, state);
    }

    return completion;
  }

  private enqueue(key: Key, state: KeyState<Snapshot>): void {
    if (state.queued || this.cancelled) {
      return;
    }

    state.queued = true;
    this.readyQueue.push(key);
    this.ensurePump();
  }

  private ensurePump(): void {
    if (this.pumpPromise || this.cancelled) {
      return;
    }

    this.pumpPromise = this.runPump().finally(() => {
      this.pumpPromise = undefined;
      if (!this.cancelled && this.readyQueue.length > 0) {
        this.ensurePump();
      }
    });
  }

  private async runPump(): Promise<void> {
    while (!this.cancelled && this.readyQueue.length > 0) {
      const key = this.readyQueue.shift() as Key;
      const state = this.states.get(key);
      if (!state) {
        continue;
      }

      state.queued = false;
      if (!state.ready) {
        continue;
      }

      state.ready = false;
      const version = state.latestVersion;
      const snapshot = state.latestSnapshot;
      state.writingVersion = version;

      let failed = false;
      let failure: unknown;
      try {
        await this.writer(key, snapshot);
      } catch (error) {
        failed = true;
        failure = error;
      }

      state.writingVersion = undefined;
      this.settleWaiters(state, version, failed, failure);

      if (
        state.latestVersion === version &&
        !state.timerScheduled &&
        !state.ready &&
        !state.queued
      ) {
        this.states.delete(key);
      }
    }
  }

  private settleWaiters(
    state: KeyState<Snapshot>,
    writtenVersion: number,
    failed: boolean,
    failure: unknown,
  ): void {
    for (const waiter of state.waiters) {
      if (waiter.version > writtenVersion) {
        continue;
      }

      state.waiters.delete(waiter);
      if (failed) {
        waiter.reject(failure);
      } else {
        waiter.resolve();
      }
    }
  }

  private async performDispose(mode: PersistenceDisposeMode): Promise<void> {
    if (mode === 'cancel') {
      this.cancelled = true;
      this.cancelPending();
      await this.waitForPump();
      return;
    }

    let failed = false;
    let failure: unknown;
    try {
      await this.flush();
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      this.cancelled = true;
      this.cancelPending();
      await this.waitForPump();
    }

    if (failed) {
      throw failure;
    }
  }

  private cancelPending(): void {
    const error = new PersistenceCoordinatorDisposedError();
    this.readyQueue.length = 0;

    for (const [key, state] of this.states) {
      this.clearTimer(state);
      state.ready = false;
      state.queued = false;

      for (const waiter of state.waiters) {
        waiter.reject(error);
      }
      state.waiters.clear();

      if (state.writingVersion === undefined) {
        this.states.delete(key);
      } else {
        // Preserve only the version that is already in flight so runPump can
        // perform its normal cleanup after the writer settles.
        state.latestVersion = state.writingVersion;
      }
    }
  }

  private async waitForPump(): Promise<void> {
    while (this.pumpPromise) {
      await this.pumpPromise;
    }
  }
}

export function createPersistenceCoordinator<Key, Snapshot>(
  writer: PersistenceWriter<Key, Snapshot>,
  options?: PersistenceCoordinatorOptions,
): PersistenceCoordinator<Key, Snapshot> {
  return new PersistenceCoordinator(writer, options);
}
