import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventSubscriptionOptions } from '@/src/opencode/client';
import type { ServerEvent } from '@/src/opencode/sse';
import type { HostConnection, MachineExecutionContract, Session } from '@/src/opencode/types';

vi.mock('./connection-storage', () => ({
  loadConnections: vi.fn(),
  saveConnections: vi.fn(() => Promise.resolve()),
  loadActiveConnectionId: vi.fn(),
  saveActiveConnectionId: vi.fn(() => Promise.resolve()),
  removeConnectionSecrets: vi.fn(() => Promise.resolve()),
}));

vi.mock('./session-cache-storage', () => ({
  loadSessionCache: vi.fn(),
  saveHostSessionCache: vi.fn(() => Promise.resolve()),
  saveSessionTranscriptCache: vi.fn(() => Promise.resolve()),
  saveQueuedPromptsCache: vi.fn(() => Promise.resolve()),
}));

vi.mock('./prompt-preferences-storage', () => ({
  loadPromptPreferences: vi.fn(() =>
    Promise.resolve({ activeAgentByHost: {}, thinkingLevel: 'high', promptMode: 'ask' }),
  ),
  savePromptPreferences: vi.fn(() => Promise.resolve()),
}));

const host: HostConnection = {
  id: 'relay',
  name: 'Relay',
  url: 'https://relay.example',
  authType: 'bearer',
  token: 'secret',
  lastConnected: null,
  isReachable: false,
};

describe('mobile store composite relay contract', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    const storage = await import('./connection-storage');
    const cache = await import('./session-cache-storage');
    vi.mocked(storage.loadConnections).mockResolvedValue([host]);
    vi.mocked(storage.loadActiveConnectionId).mockResolvedValue(host.id);
    vi.mocked(cache.loadSessionCache).mockResolvedValue(emptySessionCache());
  });

  it('hydrates only unambiguous legacy transcript keys and preserves composite cache keys', async () => {
    const cache = await import('./session-cache-storage');
    const macKey = JSON.stringify([host.id, 'mac', 'same']);
    vi.mocked(cache.loadSessionCache).mockResolvedValue({
      ...emptySessionCache(),
      sessions: {
        [host.id]: [
          { id: 'same', relayTargetID: 'mac' },
          { id: 'same', relayTargetID: 'windows' },
          { id: 'unique', relayTargetID: 'mac' },
        ],
      },
      messages: {
        same: [message('ambiguous', 'same', 'must be dropped')],
        unique: [
          message('unique-new', 'unique', 'new page', 300),
          message('unique-old', 'unique', 'older page', 100),
        ],
        [macKey]: [message('mac-message', 'same', 'already composite')],
      },
      sessionStatuses: {
        [host.id]: {
          same: { type: 'busy' },
          unique: { type: 'idle' },
          [macKey]: { type: 'retry', message: 'cached' },
        },
      },
      queuedPrompts: [
        {
          id: 'old-retry',
          connectionId: host.id,
          sessionId: 'same',
          text: 'unsafe retry',
          promptMode: 'ask',
          createdAt: '2026-07-14T12:00:00.000Z',
        },
      ],
    });
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');

    await useOpenCodeMobileStore.getState().hydrate();

    const uniqueKey = sessionStateKey({ connectionId: host.id, relayTargetID: 'mac', sessionId: 'unique' });
    expect(useOpenCodeMobileStore.getState().messages.same).toBeUndefined();
    expect(useOpenCodeMobileStore.getState().messages[macKey]?.[0].info.id).toBe('mac-message');
    expect(useOpenCodeMobileStore.getState().messages[uniqueKey]?.map((item) => item.info.id)).toEqual([
      'unique-old',
      'unique-new',
    ]);
    expect(useOpenCodeMobileStore.getState().sessionStatuses[macKey]).toEqual({ type: 'retry', message: 'cached' });
    expect(useOpenCodeMobileStore.getState().queuedPrompts).toEqual([]);
    expect(cache.saveQueuedPromptsCache).toHaveBeenCalledWith([]);
  });

  it('refreshes every relay target explicitly and keeps same-ID sessions/statuses isolated', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const target = new Headers(init?.headers).get('X-OpenCode-Target');
      if (url.endsWith('/api/pairing/me')) {
        return jsonResponse({ device: { clientID: 'phone', displayName: 'Pocket', displayNameRevision: 2 } });
      }
      if (url.endsWith('/relay/targets')) {
        return jsonResponse({ targets: [{ id: 'mac', name: 'MacBook' }, { id: 'windows', name: 'Server' }] });
      }
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true, version: target ?? 'missing' });
      if (url.endsWith('/api/session?limit=1000')) {
        expect(target).toMatch(/mac|windows/);
        return jsonResponse({
          data: [{ id: 'same', title: `${target} session`, directory: target === 'mac' ? '/repo' : 'D:/repo' }],
          cursor: {},
        });
      }
      if (url.endsWith('/session/status')) return jsonResponse({});
      if (url.includes('/session/status?')) {
        const expectedDirectory = target === 'mac' ? '/repo' : 'D:/repo';
        expect(new URL(url).searchParams.get('directory')).toBe(expectedDirectory);
        expect(new Headers(init?.headers).get('X-OpenCode-Directory')).toBe(expectedDirectory);
        return jsonResponse({ same: { type: target === 'mac' ? 'busy' : 'idle' } });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    useOpenCodeMobileStore.setState({ connections: [host], activeConnectionId: host.id });

    await useOpenCodeMobileStore.getState().refreshActiveHost();

    const state = useOpenCodeMobileStore.getState();
    const macKey = sessionStateKey({ connectionId: host.id, relayTargetID: 'mac', sessionId: 'same' });
    const windowsKey = sessionStateKey({ connectionId: host.id, relayTargetID: 'windows', sessionId: 'same' });
    expect(state.sessions[host.id]).toEqual([
      expect.objectContaining({ id: 'same', relayTargetID: 'mac', relayTargetName: 'MacBook' }),
      expect.objectContaining({ id: 'same', relayTargetID: 'windows', relayTargetName: 'Server' }),
    ]);
    expect(state.sessionStatuses[macKey]).toEqual({ type: 'busy' });
    expect(state.sessionStatuses[windowsKey]).toEqual({ type: 'idle' });
    expect(state.sessionStatuses.same).toBeUndefined();
    expect(state.relayTargets[host.id]).toEqual([
      expect.objectContaining({ id: 'mac', reachable: true }),
      expect.objectContaining({ id: 'windows', reachable: true }),
    ]);
    const sessionCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/session?'));
    expect(sessionCalls).toHaveLength(2);
    expect(sessionCalls.every(([, init]) => Boolean(new Headers(init?.headers).get('X-OpenCode-Target')))).toBe(true);
  });

  it('fully enumerates session metadata so an old session with recent activity is not lost after the first creation-time page', async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
      id: `newer-created-${index}`,
      parentID: 'root',
      time: { created: 2_000 - index, updated: 2_000 - index },
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/pairing/me')) {
        return jsonResponse({ device: { clientID: 'phone', displayName: 'Pocket' } });
      }
      if (url.endsWith('/relay/targets')) {
        return jsonResponse({ targets: [{ id: 'woody', name: 'Woody' }] });
      }
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true, version: '1.17.18' });
      if (url.endsWith('/api/session?limit=1000')) {
        return jsonResponse({ data: firstPage, cursor: { next: 'older-created' } });
      }
      if (url.endsWith('/api/session?limit=1000&cursor=older-created')) {
        return jsonResponse({
          data: [{
            id: 'old-but-active',
            title: 'Recently active giant session',
            time: { created: 1, updated: 10_000 },
          }],
          cursor: {},
        });
      }
      if (new URL(url).pathname === '/session/status') return jsonResponse({});
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { useOpenCodeMobileStore } = await import('./mobile-store');
    useOpenCodeMobileStore.setState({ connections: [host], activeConnectionId: host.id });

    await useOpenCodeMobileStore.getState().refreshActiveHost();

    const sessions = useOpenCodeMobileStore.getState().sessions[host.id];
    expect(sessions).toHaveLength(1_001);
    expect(sessions[0]).toMatchObject({
      id: 'old-but-active',
      relayTargetID: 'woody',
      relayTargetName: 'Woody',
    });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/session?'))).toHaveLength(2);
  });

  it('reads each directory once without a tunnel burst and retains status only for failed scopes', async () => {
    const sessions: Session[] = [
      { id: 'active', location: { directory: 'D:\\RL-Science-Trajectory' } },
      { id: 'finished', location: { directory: 'D:\\RL-Science-Trajectory' } },
      { id: 'unreachable', directory: 'D:\\missing' },
      { id: 'legacy' },
    ];
    const scopes: Array<string | null> = [];
    let pending = 0;
    let maxPending = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/pairing/me') return jsonResponse({ device: { clientID: 'phone' } });
      if (url.pathname === '/relay/targets') return jsonResponse({ targets: [{ id: 'windows', name: 'Windows' }] });
      expect(new Headers(init?.headers).get('X-OpenCode-Target')).toBe('windows');
      if (url.pathname === '/global/health') return jsonResponse({ healthy: true, version: '1.18.31' });
      if (url.pathname === '/api/session') return jsonResponse({ data: sessions, cursor: {} });
      if (url.pathname === '/session/status') {
        const directory = url.searchParams.get('directory');
        expect(new Headers(init?.headers).get('X-OpenCode-Directory')).toBe(directory);
        scopes.push(directory);
        maxPending = Math.max(maxPending, ++pending);
        await new Promise((resolve) => setTimeout(resolve, 5));
        pending -= 1;
        if (directory === 'D:\\missing') return jsonResponse({ error: 'unavailable directory' }, 403);
        if (!directory) return jsonResponse({ legacy: { running: true }, active: { type: 'idle' } });
        return jsonResponse({ active: { type: 'busy' } });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const key = (sessionId: string) => sessionStateKey({ connectionId: host.id, relayTargetID: 'windows', sessionId });
    useOpenCodeMobileStore.setState({
      connections: [host], activeConnectionId: host.id,
      sessionStatuses: { [key('finished')]: { type: 'busy' }, [key('unreachable')]: { type: 'busy' } },
    });

    await useOpenCodeMobileStore.getState().refreshActiveHost();

    expect(scopes).toHaveLength(3);
    expect(scopes).toEqual(expect.arrayContaining(['D:\\RL-Science-Trajectory', 'D:\\missing', null]));
    expect(maxPending).toBe(1);
    expect(useOpenCodeMobileStore.getState().sessionStatuses).toMatchObject({
      [key('active')]: { type: 'busy' }, [key('finished')]: { type: 'idle' },
      [key('unreachable')]: { type: 'busy' }, [key('legacy')]: { running: true },
    });
    expect(useOpenCodeMobileStore.getState().hostSyncErrors[host.id]).toContain('running-state checks failed for 1 project directory');
    expect(useOpenCodeMobileStore.getState().sessions[host.id]).toHaveLength(4);
  });

  it('loads an already-running Windows session without waiting for a new SSE status event', async () => {
    const directory = 'D:\\RL-Science-Trajectory';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get('X-OpenCode-Target')).toBe('windows');
      if (url.pathname === '/session/active/message') return jsonResponse([]);
      if (url.pathname === '/session/status') {
        expect(url.searchParams.get('directory')).toBe(directory);
        expect(new Headers(init?.headers).get('X-OpenCode-Directory')).toBe(directory);
        return jsonResponse({ active: { type: 'busy' } });
      }
      return jsonResponse({ error: 'optional endpoint unavailable' }, 400);
    }));
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'windows', sessionId: 'active' };
    useOpenCodeMobileStore.setState({
      connections: [host], activeConnectionId: host.id,
      sessions: { [host.id]: [{ id: 'active', relayTargetID: 'windows', location: { directory } }] },
    });

    await useOpenCodeMobileStore.getState().openSession(ref);

    expect(useOpenCodeMobileStore.getState().sessionStatuses[sessionStateKey(ref)]).toEqual({ type: 'busy' });
  });

  it('publishes the index before slow historical status reads, coalesces syncs, and bounds the status phase', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const target = new Headers(init?.headers).get('X-OpenCode-Target');
        if (url.pathname === '/api/pairing/me') return jsonResponse({ device: { clientID: 'phone' } });
        if (url.pathname === '/relay/targets') return jsonResponse({ targets: [{ id: 'mac', name: 'Mac' }, { id: 'windows', name: 'Windows' }] });
        if (url.pathname === '/global/health') return jsonResponse({ healthy: true });
        if (url.pathname === '/api/session') return jsonResponse({
          data: target === 'mac'
            ? Array.from({ length: 5 }, (_, index) => ({ id: `old-${index}`, directory: `/old/${index}` }))
            : [{ id: 'active', directory: 'D:\\repo' }],
          cursor: {},
        });
        if (url.pathname === '/session/status' && target === 'windows') return jsonResponse({ active: { type: 'busy' } });
        // Model a native request/body which ignores cancellation entirely.
        if (url.pathname === '/session/status') return new Promise<Response>(() => {});
        throw new Error(`unexpected request ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
      useOpenCodeMobileStore.setState({ connections: [host], activeConnectionId: host.id });
      const start = Date.now();
      let finished = false;
      const first = useOpenCodeMobileStore.getState().refreshActiveHost().then(() => { finished = true; });
      const second = useOpenCodeMobileStore.getState().refreshActiveHost();

      await vi.advanceTimersByTimeAsync(0);
      expect(useOpenCodeMobileStore.getState().sessions[host.id]).toHaveLength(6);
      expect(useOpenCodeMobileStore.getState().loading).toBe('idle');
      expect(finished).toBe(false);
      expect(useOpenCodeMobileStore.getState().sessionStatuses[sessionStateKey({ connectionId: host.id, relayTargetID: 'windows', sessionId: 'active' })]).toEqual({ type: 'busy' });
      expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/session')).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all([first, second]);
      expect(Date.now() - start).toBe(10_000);
      expect(finished).toBe(true);
      const statusCalls = fetchMock.mock.calls.filter(([input, init]) => new URL(String(input)).pathname === '/session/status' && new Headers(init?.headers).get('X-OpenCode-Target') === 'mac');
      expect(statusCalls).toHaveLength(4);
      expect(statusCalls.every(([, init]) => init?.signal?.aborted)).toBe(true);
      expect(useOpenCodeMobileStore.getState().hostSyncErrors[host.id]).toBe('Sync incomplete: Mac: running-state checks failed for 3 project directories');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, 31_000])('continues unchecked directories after a %i ms gap without treating expired snapshots as unfinished discovery', async (gap) => {
    vi.useFakeTimers();
    try {
      const scopes: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/pairing/me') return jsonResponse({ device: { clientID: 'phone' } });
        if (url.pathname === '/relay/targets') return jsonResponse({ targets: [{ id: 'windows', name: 'Woody' }] });
        if (url.pathname === '/global/health') return jsonResponse({ healthy: true });
        if (url.pathname === '/api/session') return jsonResponse({ data: Array.from({ length: 76 }, (_, i) => ({ id: `s${i}`, directory: `D:/${i}` })), cursor: {} });
        if (url.pathname === '/session/status') { scopes.push(url.searchParams.get('directory')!); return jsonResponse({}); }
        throw new Error(`unexpected request ${url}`);
      }));
      const { useOpenCodeMobileStore } = await import('./mobile-store');
      useOpenCodeMobileStore.setState({ connections: [host], activeConnectionId: host.id });
      const first = useOpenCodeMobileStore.getState().refreshActiveHost();
      await vi.advanceTimersByTimeAsync(10_000);
      await first;
      expect(scopes.length).toBeLessThan(76);
      expect(useOpenCodeMobileStore.getState().hostSyncErrors[host.id]).toBeNull();
      expect(useOpenCodeMobileStore.getState().hostSyncNotes[host.id]).toContain('awaiting their first running-state check');
      const firstScopes = [...scopes];
      await vi.advanceTimersByTimeAsync(gap);
      const second = useOpenCodeMobileStore.getState().refreshActiveHost();
      await vi.advanceTimersByTimeAsync(10_000);
      await second;
      if (gap === 0) expect(scopes).toHaveLength(76);
      expect(scopes.slice(firstScopes.length, 76).every((scope) => !firstScopes.includes(scope))).toBe(true);
      expect(new Set(scopes).size).toBe(76);
      expect(useOpenCodeMobileStore.getState().hostSyncErrors[host.id]).toBeNull();
      if (gap === 0) expect(useOpenCodeMobileStore.getState().hostSyncNotes[host.id]).toBeNull();
      else expect(useOpenCodeMobileStore.getState().hostSyncNotes[host.id]).toBe('Woody: showing previously checked running states');
    } finally { vi.useRealTimers(); }
  });

  it('preserves a live status event received while the directory snapshot is in flight', async () => {
    const statusResponse = deferred<Response>();
    let statusRequested = false;
    const { OpenCodeClient } = await import('@/src/opencode/client');
    let emit!: (event: ServerEvent) => void;
    vi.spyOn(OpenCodeClient.prototype, 'subscribeEvents').mockImplementation((handler) => {
      emit = handler;
      return () => undefined;
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/pairing/me') return jsonResponse({ device: { clientID: 'phone' } });
      if (url.pathname === '/relay/targets') return jsonResponse({ targets: [{ id: 'windows', name: 'Windows' }] });
      if (url.pathname === '/global/health') return jsonResponse({ healthy: true, version: '1.18.31' });
      if (url.pathname === '/api/session') return jsonResponse({ data: [{ id: 'active', directory: 'D:\\repo' }], cursor: {} });
      if (url.pathname === '/session/status') { statusRequested = true; return statusResponse.promise; }
      throw new Error(`unexpected request ${url}`);
    }));
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'windows', sessionId: 'active' };
    const key = sessionStateKey(ref);
    useOpenCodeMobileStore.setState({
      connections: [host], activeConnectionId: host.id, activeSessionRef: ref, activeSessionKey: key,
      sessions: { [host.id]: [{ id: 'active', relayTargetID: 'windows', directory: 'D:\\repo' }] },
    });
    useOpenCodeMobileStore.getState().subscribeToActiveHost();
    const refresh = useOpenCodeMobileStore.getState().refreshActiveHost();
    await eventually(() => expect(statusRequested).toBe(true));
    emit({ type: 'session.status', properties: { sessionID: 'active', status: { type: 'busy' } } });
    statusResponse.resolve(jsonResponse({}));
    await refresh;

    expect(useOpenCodeMobileStore.getState().sessionStatuses[key]).toEqual({ type: 'busy' });
    useOpenCodeMobileStore.getState().unsubscribeFromHost(host.id);
  });

  it('reconciles the active directory on reconnect and clears a completed session without clearing another target', async () => {
    const { OpenCodeClient } = await import('@/src/opencode/client');
    let reconnect: EventSubscriptionOptions['onReconnect'];
    vi.spyOn(OpenCodeClient.prototype, 'subscribeEvents').mockImplementation((_handler, options) => {
      reconnect = options?.onReconnect;
      return () => undefined;
    });
    const statusRead = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get('X-OpenCode-Target')).toBe('windows');
      if (url.pathname === '/session/status') {
        expect(url.searchParams.get('directory')).toBe('D:\\repo');
        return jsonResponse({});
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', statusRead);
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'windows', sessionId: 'active' };
    const key = sessionStateKey(ref);
    const macKey = sessionStateKey({ ...ref, relayTargetID: 'mac' });
    useOpenCodeMobileStore.setState({
      connections: [host], activeConnectionId: host.id, activeSessionRef: ref, activeSessionKey: key,
      sessions: { [host.id]: [{ id: 'active', relayTargetID: 'windows', directory: 'D:\\repo' }] },
      sessionStatuses: { [key]: { type: 'busy' }, [macKey]: { type: 'busy' } },
      refreshActiveHost: vi.fn(async () => undefined),
    });
    useOpenCodeMobileStore.getState().subscribeToActiveHost();

    await reconnect?.();

    expect(statusRead.mock.calls.some(([input]) => new URL(String(input)).pathname === '/session/status')).toBe(true);
    expect(useOpenCodeMobileStore.getState().sessionStatuses[key]).toEqual({ type: 'idle' });
    expect(useOpenCodeMobileStore.getState().sessionStatuses[macKey]).toEqual({ type: 'busy' });
    useOpenCodeMobileStore.getState().unsubscribeFromHost(host.id);
  });

  it('does not fall through to a relay default target when the authorized target list is empty', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/pairing/me')) {
        return jsonResponse({ device: { clientID: 'phone', displayName: 'Pocket' } });
      }
      if (url.endsWith('/relay/targets')) return jsonResponse({ targets: [] });
      throw new Error(`default target must not be probed: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { useOpenCodeMobileStore } = await import('./mobile-store');
    useOpenCodeMobileStore.setState({ connections: [host], activeConnectionId: host.id });

    await useOpenCodeMobileStore.getState().refreshActiveHost();

    expect(useOpenCodeMobileStore.getState().loading).toBe('error');
    expect(useOpenCodeMobileStore.getState().error).toContain('No authorized relay machine');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/session'))).toBe(false);
  });

  it('surfaces a background sync failure without discarding cached sessions', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'relay unavailable' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const { useOpenCodeMobileStore } = await import('./mobile-store');
    const cached: Session[] = [{ id: 'cached', relayTargetID: 'mac', directory: '/repo' }];
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      sessions: { [host.id]: cached },
    });

    await useOpenCodeMobileStore.getState().refreshActiveHost({ background: true });

    const state = useOpenCodeMobileStore.getState();
    expect(state.sessions[host.id]).toEqual(cached);
    expect(state.hostSyncStates[host.id]).toBe('error');
    expect(state.hostSyncErrors[host.id]).toContain('relay unavailable');
    expect(state.loading).toBe('error');
    expect(state.error).toContain('relay unavailable');
  });

  it('applies canonical relay target names to retained sessions when that machine is offline', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const target = new Headers(init?.headers).get('X-OpenCode-Target');
      if (url.endsWith('/api/pairing/me')) {
        return jsonResponse({ device: { clientID: 'phone', displayName: 'Pocket', displayNameRevision: 2 } });
      }
      if (url.endsWith('/relay/targets')) {
        return jsonResponse({ targets: [{ id: 'mac', name: 'MacBook' }, { id: 'windows', name: 'Server' }] });
      }
      if (target === 'windows') return jsonResponse({ error: 'machine offline' }, 503);
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true, version: '1.17.18' });
      if (url.endsWith('/api/session?limit=1000')) {
        return jsonResponse({ data: [{ id: 'mac-live', relayTargetID: 'mac', directory: '/repo' }], cursor: {} });
      }
      if (new URL(url).pathname === '/session/status') return jsonResponse({});
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { useOpenCodeMobileStore } = await import('./mobile-store');
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      sessions: {
        [host.id]: [{
          id: 'windows-cached',
          relayTargetID: 'windows',
          relayTargetName: 'Windows workstation',
          directory: 'D:/repo',
        }],
      },
    });

    await useOpenCodeMobileStore.getState().refreshActiveHost();

    const windows = useOpenCodeMobileStore.getState().sessions[host.id]
      .find((session) => session.relayTargetID === 'windows');
    expect(windows?.relayTargetName).toBe('Server');
  });

  it('opens same-ID sessions on two machines into different composite transcript keys', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const target = new Headers(init?.headers).get('X-OpenCode-Target');
      if (url.includes('/session/same/message?')) return jsonResponse([message(`${target}-message`, 'same', String(target))]);
      return jsonResponse({ error: 'optional endpoint unavailable' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      sessions: {
        [host.id]: [
          { id: 'same', relayTargetID: 'mac', directory: '/repo' },
          { id: 'same', relayTargetID: 'windows', directory: 'D:/repo' },
        ],
      },
    });
    const mac = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'same' };
    const windows = { connectionId: host.id, relayTargetID: 'windows', sessionId: 'same' };

    await useOpenCodeMobileStore.getState().openSession(mac);
    await useOpenCodeMobileStore.getState().openSession(windows);

    expect(useOpenCodeMobileStore.getState().messages[sessionStateKey(mac)]?.[0].info.id).toBe('mac-message');
    expect(useOpenCodeMobileStore.getState().messages[sessionStateKey(windows)]?.[0].info.id).toBe('windows-message');
    expect(useOpenCodeMobileStore.getState().messages.same).toBeUndefined();
    const messageTargets = fetchMock.mock.calls
      .filter(([input]) => String(input).includes('/message?'))
      .map(([, init]) => new Headers(init?.headers).get('X-OpenCode-Target'));
    expect(messageTargets).toEqual(['mac', 'windows']);
  });

  it('loads only the newest message page, then fetches older pages explicitly without reordering parts', async () => {
    const latestParts = [
      { id: 'step-start', type: 'step-start' as const },
      { id: 'reasoning', type: 'reasoning' as const, text: 'Checking cutover' },
      { id: 'final-report', type: 'text' as const, text: 'CAUTION latest report' },
      { id: 'step-finish', type: 'step-finish' as const },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/session/session-1/message?limit=50')) {
        return jsonResponse([
          { info: { id: 'new-1', sessionID: 'session-1', role: 'assistant' as const, time: { created: 300 } }, parts: [] },
          { info: { id: 'new-2', sessionID: 'session-1', role: 'assistant' as const, time: { created: 400 } }, parts: latestParts },
        ], 200, { 'X-Next-Cursor': 'older-page' });
      }
      if (url.endsWith('/session/session-1/message?limit=50&before=older-page')) {
        return jsonResponse([
          { info: { id: 'old-1', sessionID: 'session-1', role: 'assistant' as const, time: { created: 100 } }, parts: [] },
          { info: { id: 'old-2', sessionID: 'session-1', role: 'assistant' as const, time: { created: 200 } }, parts: [] },
        ]);
      }
      return jsonResponse({ error: 'optional endpoint unavailable' }, 400);
    }));
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'session-1' };
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      sessions: { [host.id]: [{ id: ref.sessionId, relayTargetID: ref.relayTargetID, directory: '/repo' }] },
    });

    await useOpenCodeMobileStore.getState().openSession(ref);

    const key = sessionStateKey(ref);
    expect(useOpenCodeMobileStore.getState().messages[key]?.map((item) => item.info.id)).toEqual(['new-1', 'new-2']);
    expect(useOpenCodeMobileStore.getState().messageNextCursors[key]).toBe('older-page');

    await useOpenCodeMobileStore.getState().loadOlderMessages(ref);

    const transcript = useOpenCodeMobileStore.getState().messages[key] ?? [];
    expect(transcript.map((item) => item.info.id)).toEqual(['old-1', 'old-2', 'new-1', 'new-2']);
    expect(useOpenCodeMobileStore.getState().messageNextCursors[key]).toBeNull();
    expect(useOpenCodeMobileStore.getState().olderMessageLoadStates[key]).toBe('idle');
    expect(transcript.at(-1)?.parts.map((part) => part.id)).toEqual([
      'step-start',
      'reasoning',
      'final-report',
      'step-finish',
    ]);
  });

  it('deduplicates concurrent opens and merges a late REST snapshot behind newer live state', async () => {
    const pending = deferred<Response>();
    let messageRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/session/session-1/message?')) {
        messageRequests += 1;
        return pending.promise;
      }
      return jsonResponse({ error: 'optional endpoint unavailable' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'session-1' };
    const key = sessionStateKey(ref);
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      sessions: { [host.id]: [{ id: ref.sessionId, relayTargetID: ref.relayTargetID, directory: '/repo' }] },
    });

    const first = useOpenCodeMobileStore.getState().openSession(ref);
    const second = useOpenCodeMobileStore.getState().openSession(ref);
    await eventually(() => expect(messageRequests).toBe(1));
    useOpenCodeMobileStore.setState({
      messages: {
        [key]: [{
          info: { id: 'assistant', sessionID: ref.sessionId, role: 'assistant' },
          parts: [
            { id: 'part-2', messageID: 'assistant', type: 'text', text: 'new live token' },
            { id: 'part-4', messageID: 'assistant', type: 'text', text: 'live append' },
          ],
        }],
      },
    });
    pending.resolve(jsonResponse([{
      info: { id: 'assistant', sessionID: ref.sessionId, role: 'assistant' },
      parts: [
        { id: 'part-1', messageID: 'assistant', type: 'text', text: 'REST one' },
        { id: 'part-2', messageID: 'assistant', type: 'text', text: 'stale REST token' },
        { id: 'part-3', messageID: 'assistant', type: 'text', text: 'REST three' },
      ],
    }]));
    await Promise.all([first, second]);

    expect(messageRequests).toBe(1);
    expect(useOpenCodeMobileStore.getState().messages[key]?.[0].parts).toEqual([
      expect.objectContaining({ id: 'part-1', text: 'REST one' }),
      expect.objectContaining({ id: 'part-2', text: 'new live token' }),
      expect.objectContaining({ id: 'part-3', text: 'REST three' }),
      expect.objectContaining({ id: 'part-4', text: 'live append' }),
    ]);
  });

  it('loads agents, models, config and arbitrary variants from the exact machine+directory contract', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      expect(headers.get('X-OpenCode-Target')).toBe('mac');
      if (url.includes('/session/session-1/message?')) {
        return jsonResponse([{
          info: {
            id: 'user',
            sessionID: 'session-1',
            role: 'user',
            agent: 'build',
            model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'xhigh' },
          },
          parts: [{ type: 'text', text: 'continue' }],
        }]);
      }
      if (url.includes('/agent?directory=')) {
        expect(headers.get('X-OpenCode-Directory')).toBe('/Users/me/repo');
        return jsonResponse([
          { name: 'build', mode: 'primary', model: 'openai/gpt-5.5' },
          { name: 'explore', mode: 'subagent', model: 'openai/gpt-5-mini' },
        ]);
      }
      if (url.includes('/config/providers?directory=')) {
        return jsonResponse({
          providers: [{
            id: 'openai',
            name: 'OpenAI',
            models: {
              'gpt-5.5': {
                id: 'gpt-5.5',
                providerID: 'openai',
                name: 'GPT-5.5',
                variants: { minimal: {}, high: {}, xhigh: {} },
              },
              'gpt-5-mini': {
                id: 'gpt-5-mini',
                providerID: 'openai',
                name: 'GPT-5 mini',
                variants: { fast: {} },
              },
            },
          }],
          default: { openai: 'gpt-5.5' },
        });
      }
      if (/\/config\?directory=/.test(url)) return jsonResponse({ model: 'openai/gpt-5-mini' });
      if (url.includes('/command?directory=')) return jsonResponse([{ name: 'share' }]);
      if (url.includes('/question?directory=')) return jsonResponse([]);
      if (url.includes('/session/session-1/diff')) return jsonResponse([]);
      if (url.includes('/session/session-1/todo')) return jsonResponse([]);
      if (url.includes('/api/session/session-1/context')) return jsonResponse({ data: [] });
      if (url.includes('/lsp?directory=')) return jsonResponse([]);
      if (url.includes('/mcp?directory=')) return jsonResponse({});
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executionScopeKey, sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'session-1' };
    const session: Session = { id: ref.sessionId, relayTargetID: ref.relayTargetID, directory: '/Users/me/repo' };
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      sessions: { [host.id]: [session] },
    });

    await useOpenCodeMobileStore.getState().openSession(ref);

    const state = useOpenCodeMobileStore.getState();
    const key = sessionStateKey(ref);
    const scope = executionScopeKey(ref, session.directory);
    expect(state.machineContracts[scope]).toEqual(expect.objectContaining({
      connectionId: host.id,
      relayTargetID: 'mac',
      directory: '/Users/me/repo',
      agents: [
        expect.objectContaining({ name: 'build' }),
        expect.objectContaining({ name: 'explore' }),
      ],
      providerDefaults: { openai: 'gpt-5.5' },
      configModel: 'openai/gpt-5-mini',
    }));
    expect(state.contractLoadStates[scope]).toEqual(expect.objectContaining({
      status: 'fresh',
      verifiedAt: expect.any(String),
      error: null,
    }));
    expect(state.sessionSelections[key]).toEqual({
      agentName: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      variant: 'xhigh',
    });
    expect(state.agents[scope]).toHaveLength(2);
    expect(state.commands[scope]).toEqual([{ name: 'share' }]);

    expect(useOpenCodeMobileStore.getState().setSessionVariant(ref, 'minimal')).toBe(true);
    expect(useOpenCodeMobileStore.getState().sessionSelections[key].variant).toBe('minimal');
    expect(useOpenCodeMobileStore.getState().setSessionVariant(ref, 'hardcoded-max')).toBe(false);
    expect(useOpenCodeMobileStore.getState().setSessionVariant(ref, undefined)).toBe(true);
    expect(useOpenCodeMobileStore.getState().sessionSelections[key]).not.toHaveProperty('variant');
    expect(useOpenCodeMobileStore.getState().setSessionModel(ref, { providerID: 'openai', modelID: 'gpt-5-mini' })).toBe(true);
    expect(useOpenCodeMobileStore.getState().sessionSelections[key].model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5-mini',
    });
  });

  it('treats auxiliary endpoint failures as partial data, not a global offline transcript', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/session/session-1/message?')) return jsonResponse([message('live', 'session-1', 'core transcript')]);
      return jsonResponse({ error: 'unsupported optional endpoint' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executionScopeKey, sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'session-1' };
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      sessions: { [host.id]: [{ id: ref.sessionId, relayTargetID: 'mac', directory: '/repo' }] },
    });

    await useOpenCodeMobileStore.getState().openSession(ref);

    const state = useOpenCodeMobileStore.getState();
    expect(state.messages[sessionStateKey(ref)]?.[0].info.id).toBe('live');
    expect(state.sessionLoadStates[sessionStateKey(ref)]).toBe('idle');
    expect(state.sessionErrors[sessionStateKey(ref)]).toBeNull();
    expect(state.contractLoadStates[executionScopeKey(ref, '/repo')]).toEqual(expect.objectContaining({
      status: 'error',
      error: expect.stringContaining('verification'),
    }));
    expect(state.loading).toBe('idle');
    expect(state.error).toBeNull();
  });

  it('keeps a failed contract load explicitly stale and blocks dispatch through the cached selection', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/session/session-1/message?')) return jsonResponse([]);
      return jsonResponse({ error: 'contract endpoint unavailable' }, 503);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executionScopeKey, sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'session-1' };
    const key = sessionStateKey(ref);
    const scope = executionScopeKey(ref, '/repo');
    const cachedContract = testMachineContract(ref, '/repo', '2026-07-14T12:00:00.000Z');
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      sessions: { [host.id]: [{ id: ref.sessionId, relayTargetID: 'mac', directory: '/repo' }] },
      machineContracts: { [scope]: cachedContract },
      contractLoadStates: {
        [scope]: {
          status: 'fresh',
          attemptedAt: cachedContract.fetchedAt,
          verifiedAt: cachedContract.fetchedAt,
          error: null,
        },
      },
      sessionSelections: {
        [key]: { agentName: 'build', model: { providerID: 'openai', modelID: 'gpt-5.5' } },
      },
    });

    await useOpenCodeMobileStore.getState().openSession(ref);

    const loaded = useOpenCodeMobileStore.getState();
    expect(loaded.machineContracts[scope]).toBe(cachedContract);
    expect(loaded.contractLoadStates[scope]).toEqual(expect.objectContaining({
      status: 'stale',
      verifiedAt: cachedContract.fetchedAt,
      error: expect.stringContaining('contract endpoint unavailable'),
    }));
    const callsBeforeSend = fetchMock.mock.calls.length;
    await expect(useOpenCodeMobileStore.getState().sendPrompt('must not use stale config')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeSend);
    expect(useOpenCodeMobileStore.getState().error).toContain('stale');
  });

  it('blocks dispatch when a selection exists but its machine contract was never verified', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'session-1' };
    const key = sessionStateKey(ref);
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      activeSessionRef: ref,
      activeSessionKey: key,
      activeSessionId: ref.sessionId,
      sessions: { [host.id]: [{ id: ref.sessionId, relayTargetID: 'mac', directory: '/repo' }] },
      sessionSelections: {
        [key]: { agentName: 'build', model: { providerID: 'openai', modelID: 'gpt-5.5' } },
      },
    });

    await expect(useOpenCodeMobileStore.getState().sendPrompt('must not guess')).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useOpenCodeMobileStore.getState().error).toContain('unverified');
  });

  it('dispatches only into an existing session with the resolved machine selection and never auto-retries', async () => {
    let failDispatch = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/session/session-1/prompt_async?')) {
        return failDispatch ? jsonResponse({ error: 'invalid model' }, 400) : emptyResponse();
      }
      if (url.includes('/session/session-1/message?')) return jsonResponse([]);
      if (url.includes('/question?')) return jsonResponse([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executionScopeKey, sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'session-1' };
    const key = sessionStateKey(ref);
    const scope = executionScopeKey(ref, '/repo');
    const contract = testMachineContract(ref, '/repo');
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      activeSessionRef: ref,
      activeSessionKey: key,
      activeSessionId: ref.sessionId,
      sessions: { [host.id]: [{ id: ref.sessionId, relayTargetID: 'mac', directory: '/repo' }] },
      sessionSelections: {
        [key]: {
          agentName: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5.5' },
          variant: 'xhigh',
        },
      },
      machineContracts: { [scope]: contract },
      contractLoadStates: {
        [scope]: { status: 'fresh', attemptedAt: contract.fetchedAt, verifiedAt: contract.fetchedAt, error: null },
      },
    });

    await expect(useOpenCodeMobileStore.getState().sendPrompt('Run focused tests')).resolves.toBe(ref.sessionId);

    const dispatchCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/prompt_async?'));
    expect(dispatchCall).toBeDefined();
    expect(new Headers(dispatchCall?.[1]?.headers).get('X-OpenCode-Target')).toBe('mac');
    expect(JSON.parse(String(dispatchCall?.[1]?.body))).toEqual({
      parts: [{ type: 'text', text: 'Run focused tests' }],
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      variant: 'xhigh',
    });
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/session') && init?.method === 'POST')).toBe(false);

    failDispatch = true;
    const beforeFailureCalls = fetchMock.mock.calls.length;
    await expect(useOpenCodeMobileStore.getState().sendPrompt('Invalid dispatch')).resolves.toBeNull();
    expect(useOpenCodeMobileStore.getState().queuedPrompts).toEqual([]);
    const failureCalls = fetchMock.mock.calls.slice(beforeFailureCalls).filter(([input]) => String(input).includes('/prompt_async?'));
    expect(failureCalls).toHaveLength(1);
  });

  it('never creates a session when no existing session is active', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { useOpenCodeMobileStore } = await import('./mobile-store');
    useOpenCodeMobileStore.setState({ connections: [host], activeConnectionId: host.id, activeSessionRef: null });

    await expect(useOpenCodeMobileStore.getState().sendPrompt('Do not create')).resolves.toBeNull();
    useOpenCodeMobileStore.getState().startNewSessionPrompt();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useOpenCodeMobileStore.getState().error).toContain('does not create sessions');
  });

  it('does not expose fork as a backdoor session-creation operation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'session-1' };
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      sessions: { [host.id]: [{ id: ref.sessionId, relayTargetID: 'mac', directory: '/repo' }] },
    });

    await expect(useOpenCodeMobileStore.getState().forkSession(ref, 'message-1')).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useOpenCodeMobileStore.getState().error).toContain('does not create or fork sessions');
  });

  it('keeps existing-session controls routed to the selected relay target', async () => {
    const routedMutations: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      expect(new Headers(init?.headers).get('X-OpenCode-Target')).toBe('mac');
      if (method !== 'GET') routedMutations.push(`${method} ${new URL(url).pathname}`);
      if (method === 'PATCH' && url.endsWith('/session/session-1')) {
        return jsonResponse({ id: 'session-1', title: 'Renamed', directory: '/repo' });
      }
      if (method === 'POST' && url.endsWith('/session/session-1/share')) {
        return jsonResponse({ id: 'session-1', share: { url: 'https://share.example/session-1' } });
      }
      if (method === 'POST' && (url.endsWith('/session/session-1/revert') || url.endsWith('/session/session-1/unrevert'))) {
        return jsonResponse({ id: 'session-1', directory: '/repo' });
      }
      if (method === 'POST') return emptyResponse();
      if (url.includes('/session/session-1/message?')) return jsonResponse([]);
      return jsonResponse({ error: 'optional endpoint unavailable' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'session-1' };
    const key = sessionStateKey(ref);
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      sessions: { [host.id]: [{ id: ref.sessionId, relayTargetID: 'mac', directory: '/repo' }] },
      sessionSelections: {
        [key]: { agentName: 'build', model: { providerID: 'openai', modelID: 'gpt-5.5' } },
      },
    });

    await useOpenCodeMobileStore.getState().renameSession(ref, ' Renamed ');
    await expect(useOpenCodeMobileStore.getState().shareSession(ref)).resolves.toBe('https://share.example/session-1');
    await useOpenCodeMobileStore.getState().compactSession(ref);
    await useOpenCodeMobileStore.getState().revertMessage(ref, 'message-1');
    await useOpenCodeMobileStore.getState().unrevertSession(ref);
    await useOpenCodeMobileStore.getState().respondToPermission(ref, 'permission-1', 'reject');
    await useOpenCodeMobileStore.getState().respondToQuestion(ref, { requestID: 'question-1', answers: [['yes']] });
    await useOpenCodeMobileStore.getState().rejectQuestion(ref, 'question-2');

    expect(routedMutations).toEqual(expect.arrayContaining([
      'PATCH /session/session-1',
      'POST /session/session-1/share',
      'POST /session/session-1/summarize',
      'POST /session/session-1/revert',
      'POST /session/session-1/unrevert',
      'POST /permission/permission-1/reply',
      'POST /question/question-1/reply',
      'POST /question/question-2/reject',
    ]));
    expect(routedMutations.some((entry) => entry.endsWith('/session/session-1/fork'))).toBe(false);
  });

  it('publishes an already-pending permission before slow optional services and isolates same-ID machines', async () => {
    const { OpenCodeClient } = await import('@/src/opencode/client');
    const optional = deferred<any>();
    vi.spyOn(OpenCodeClient.prototype, 'getLspStatus').mockReturnValue(optional.promise);
    const permission = { id: 'per_gate', sessionID: 'same', permission: 'external_directory', patterns: ['/etc/*'], metadata: { command: 'cat /etc/hosts' }, always: ['/etc/*'] };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/permission') {
        expect(new Headers(init?.headers).get('X-OpenCode-Target')).toBe('mac');
        expect(url.searchParams.get('directory')).toBe('/Users/test');
        return jsonResponse([permission, { ...permission, id: 'per_other', sessionID: 'other' }]);
      }
      return jsonResponse({ error: 'optional unavailable' }, 400);
    }));
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'same' };
    const key = sessionStateKey(ref);
    const windowsKey = sessionStateKey({ ...ref, relayTargetID: 'windows' });
    useOpenCodeMobileStore.setState({ connections: [host], activeConnectionId: host.id,
      sessions: { [host.id]: [{ id: 'same', relayTargetID: 'mac', directory: '/Users/test' }] },
      permissions: { [windowsKey]: [{ ...permission, id: 'per_windows' }] },
    });
    const loading = useOpenCodeMobileStore.getState().openSession(ref);
    await eventually(() => expect(useOpenCodeMobileStore.getState().permissions[key]).toEqual([permission]));
    expect(useOpenCodeMobileStore.getState().sessionLoadStates[key]).toBe('loading');
    expect(useOpenCodeMobileStore.getState().permissions[windowsKey][0].id).toBe('per_windows');
    optional.resolve([]);
    await loading;
  });

  it('deduplicates live permission gates and never resurrects a replied gate from an older REST read', async () => {
    const { OpenCodeClient } = await import('@/src/opencode/client');
    let emit!: (event: ServerEvent) => void;
    vi.spyOn(OpenCodeClient.prototype, 'subscribeEvents').mockImplementation((handler) => { emit = handler; return () => undefined; });
    const response = deferred<any>();
    vi.spyOn(OpenCodeClient.prototype, 'listPermissions').mockReturnValue(response.promise);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'optional unavailable' }, 400)));
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'same' };
    const key = sessionStateKey(ref);
    const permission = { id: 'per_gate', sessionID: 'same', permission: 'external_directory', patterns: ['/etc/*'], metadata: {}, always: ['/etc/*'] };
    useOpenCodeMobileStore.setState({ connections: [host], activeConnectionId: host.id,
      sessions: { [host.id]: [{ id: 'same', relayTargetID: 'mac', directory: '/repo' }] },
    });
    const loading = useOpenCodeMobileStore.getState().openSession(ref);
    useOpenCodeMobileStore.getState().subscribeToActiveHost();
    emit({ type: 'permission.asked', properties: permission });
    emit({ type: 'permission.asked', properties: permission });
    expect(useOpenCodeMobileStore.getState().permissions[key]).toHaveLength(1);
    emit({ type: 'permission.replied', properties: { sessionID: 'same', requestID: 'per_gate', reply: 'once' } });
    response.resolve([permission]);
    await loading;
    expect(useOpenCodeMobileStore.getState().permissions[key]).toEqual([]);
    useOpenCodeMobileStore.getState().unsubscribeFromHost(host.id);
  });

  it('keeps failed permission decisions pending and removes them only after successful submission', async () => {
    const { OpenCodeClient } = await import('@/src/opencode/client');
    const reply = vi.spyOn(OpenCodeClient.prototype, 'respondToPermission').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'windows', sessionId: 'same' };
    const key = sessionStateKey(ref);
    const request = { id: 'per_gate', sessionID: 'same', permission: 'read', patterns: ['C:/outside/*'], metadata: {}, always: [] };
    useOpenCodeMobileStore.setState({ connections: [host], activeConnectionId: host.id,
      sessions: { [host.id]: [{ id: 'same', relayTargetID: 'windows', directory: 'D:/repo', workspaceID: 'ws_1' }] },
      permissions: { [key]: [request] },
    });
    await expect(useOpenCodeMobileStore.getState().respondToPermission(ref, request.id, 'reject', 'Stay inside')).rejects.toThrow('offline');
    expect(useOpenCodeMobileStore.getState().permissions[key]).toEqual([request]);
    await useOpenCodeMobileStore.getState().respondToPermission(ref, request.id, 'reject', 'Stay inside');
    expect(reply).toHaveBeenLastCalledWith('same', 'per_gate', { reply: 'reject', message: 'Stay inside' }, { directory: 'D:/repo', workspace: 'ws_1' });
    expect(useOpenCodeMobileStore.getState().permissions[key]).toEqual([]);
  });

  it('reconciles missed permission gates on reconnect without waiting for host status synchronization', async () => {
    const { OpenCodeClient } = await import('@/src/opencode/client');
    let reconnect: EventSubscriptionOptions['onReconnect'];
    vi.spyOn(OpenCodeClient.prototype, 'subscribeEvents').mockImplementation((_handler, options) => { reconnect = options?.onReconnect; return () => undefined; });
    const request = { id: 'per_gate', sessionID: 'same', permission: 'read', patterns: ['/etc/*'], metadata: {}, always: [] };
    vi.spyOn(OpenCodeClient.prototype, 'listPermissions').mockResolvedValue([request]);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'optional unavailable' }, 400)));
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'same' };
    const key = sessionStateKey(ref);
    const sync = deferred<void>();
    useOpenCodeMobileStore.setState({ connections: [host], activeConnectionId: host.id, activeSessionRef: ref, activeSessionKey: key,
      sessions: { [host.id]: [{ id: 'same', relayTargetID: 'mac', directory: '/repo' }] },
      refreshActiveHost: vi.fn(() => sync.promise),
    });
    useOpenCodeMobileStore.getState().subscribeToActiveHost();
    const reconciliation = reconnect?.();
    await eventually(() => expect(useOpenCodeMobileStore.getState().permissions[key]).toEqual([request]));
    sync.resolve();
    await reconciliation;
    useOpenCodeMobileStore.getState().unsubscribeFromHost(host.id);
  });

  it('refuses ambiguous bare session IDs instead of guessing a relay machine', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { useOpenCodeMobileStore } = await import('./mobile-store');
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      sessions: {
        [host.id]: [
          { id: 'same', relayTargetID: 'mac', directory: '/repo' },
          { id: 'same', relayTargetID: 'windows', directory: 'D:/repo' },
        ],
      },
    });

    await useOpenCodeMobileStore.getState().openSession('same');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useOpenCodeMobileStore.getState().error).toContain('ambiguous across relay machines');
  });

  it('routes SSE events into the active composite target and never a bare session ID', async () => {
    const cache = await import('./session-cache-storage');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const target = new Headers(init?.headers).get('X-OpenCode-Target');
      expect(target).toBe('mac');
      const frames = [
        { type: 'server.connected', properties: {} },
        { type: 'session.status', properties: { sessionID: 'same', status: { type: 'busy' } } },
        { type: 'message.updated', properties: { info: { id: 'assistant', sessionID: 'same', role: 'assistant' } } },
        {
          type: 'message.part.updated',
          properties: { part: { id: 'part', messageID: 'assistant', sessionID: 'same', type: 'text', text: 'streamed' } },
        },
      ];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { flushMobileSessionPersistence, sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'same' };
    const key = sessionStateKey(ref);
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      activeSessionRef: ref,
      activeSessionKey: key,
      activeSessionId: ref.sessionId,
      sessions: { [host.id]: [{ id: ref.sessionId, relayTargetID: 'mac', directory: '/repo' }] },
    });

    useOpenCodeMobileStore.getState().subscribeToActiveHost();
    await eventually(() => {
      expect(useOpenCodeMobileStore.getState().sessionStatuses[key]).toEqual({ type: 'busy' });
      expect(useOpenCodeMobileStore.getState().messages[key]?.[0].parts).toEqual([
        expect.objectContaining({ id: 'part', text: 'streamed' }),
      ]);
    });
    useOpenCodeMobileStore.getState().unsubscribeFromHost(host.id);
    await flushMobileSessionPersistence();

    expect(useOpenCodeMobileStore.getState().sessionStatuses.same).toBeUndefined();
    expect(useOpenCodeMobileStore.getState().messages.same).toBeUndefined();
    expect(cache.saveSessionTranscriptCache).toHaveBeenCalledWith(key, expect.any(Object));
  });

  it('distinguishes intentional subscription idle from a real transport outage', async () => {
    const { OpenCodeClient } = await import('@/src/opencode/client');
    let reportConnectionState:
      | ((state: 'connecting' | 'live' | 'reconciling' | 'offline', error?: unknown) => void)
      | undefined;
    vi.spyOn(OpenCodeClient.prototype, 'subscribeEvents').mockImplementation((_handler, options = {}) => {
      reportConnectionState = options.onConnectionState;
      return () => reportConnectionState?.('offline', new Error('subscription stopped'));
    });
    const { sessionStateKey, useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'session-1' };
    const key = sessionStateKey(ref);
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      activeSessionRef: ref,
      activeSessionKey: key,
      activeSessionId: ref.sessionId,
      sessions: { [host.id]: [{ id: ref.sessionId, relayTargetID: 'mac', directory: '/repo' }] },
    });

    useOpenCodeMobileStore.getState().subscribeToActiveHost();
    reportConnectionState?.('live');
    expect(useOpenCodeMobileStore.getState().eventConnectionStates[key]).toBe('live');

    useOpenCodeMobileStore.getState().unsubscribeFromHost(host.id);
    expect(useOpenCodeMobileStore.getState().eventConnectionStates[key]).toBe('idle');
    expect(useOpenCodeMobileStore.getState().eventConnected[key]).toBe(false);

    useOpenCodeMobileStore.getState().subscribeToActiveHost();
    reportConnectionState?.('offline', new Error('relay unreachable'));
    expect(useOpenCodeMobileStore.getState().eventConnectionStates[key]).toBe('offline');
    expect(useOpenCodeMobileStore.getState().eventConnected[key]).toBe(false);
  });
});

function testMachineContract(
  ref: { connectionId: string; relayTargetID: string },
  directory: string,
  fetchedAt = '2026-07-14T12:00:00.000Z',
): MachineExecutionContract {
  return {
    connectionId: ref.connectionId,
    relayTargetID: ref.relayTargetID,
    directory,
    agents: [{ name: 'build', mode: 'primary', model: 'openai/gpt-5.5' }],
    providers: [{
      id: 'openai',
      models: {
        'gpt-5.5': {
          id: 'gpt-5.5',
          providerID: 'openai',
          name: 'GPT-5.5',
          variants: { xhigh: {} },
        },
      },
    }],
    providerDefaults: { openai: 'gpt-5.5' },
    commands: [],
    fetchedAt,
  };
}

function message(id: string, sessionID: string, text: string, created?: number) {
  return {
    info: { id, sessionID, role: 'user' as const, time: created === undefined ? undefined : { created } },
    parts: [{ type: 'text' as const, text }],
  };
}

function emptySessionCache() {
  return {
    sessions: {},
    projects: {},
    sessionStatuses: {},
    agents: {},
    commands: {},
    messages: {},
    diffs: {},
    todos: {},
    sessionContexts: {},
    lspStatuses: {},
    mcpStatuses: {},
    queuedPrompts: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => void) {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function jsonResponse(body: unknown, status = 200, responseHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...responseHeaders },
  });
}

function emptyResponse(status = 204) {
  return new Response(null, { status });
}
