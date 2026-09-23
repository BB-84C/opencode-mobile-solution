import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      if (url.endsWith('/session/status')) {
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
      if (url.endsWith('/session/status')) return jsonResponse({});
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
      if (url.endsWith('/session/status')) return jsonResponse({});
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

  it('learns a machine\'s agents and models without a session existing there', async () => {
    // A fresh install has no session anywhere, so the contract cache is empty and
    // the new-session form would have nothing to offer.
    const respond = (url: string) => {
      if (url.includes('/agent')) return [{ name: 'build' }, { name: 'plan' }];
      if (url.includes('/config/providers')) {
        return {
          providers: [{
            id: 'anthropic',
            name: 'Anthropic',
            models: { 'claude-opus-5': { id: 'claude-opus-5', providerID: 'anthropic', name: 'Claude Opus 5' } },
          }],
          default: { anthropic: 'claude-opus-5' },
        };
      }
      if (url.includes('/command')) return [];
      return {};
    };
    const fetchMock = vi.fn(async (input: unknown) => new Response(JSON.stringify(respond(String(input))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { useOpenCodeMobileStore, executionScopeKey } = await import('./mobile-store');
    useOpenCodeMobileStore.setState({ connections: [host], machineContracts: {} });

    const loaded = await useOpenCodeMobileStore.getState().loadMachineContract({
      connectionId: host.id,
      relayTargetID: 'mac',
      directory: '/repo',
    });

    expect(loaded).toBe(true);
    const key = executionScopeKey({ connectionId: host.id, relayTargetID: 'mac' }, '/repo');
    const contract = useOpenCodeMobileStore.getState().machineContracts[key];
    expect(contract?.agents.map((agent) => agent.name)).toContain('build');
    expect(contract?.providers.length).toBeGreaterThan(0);
  });

  it('reports failure rather than caching a contract a machine could not supply', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const { useOpenCodeMobileStore } = await import('./mobile-store');
    useOpenCodeMobileStore.setState({ connections: [host], machineContracts: {} });

    const loaded = await useOpenCodeMobileStore.getState().loadMachineContract({
      connectionId: host.id,
      relayTargetID: 'mac',
    });

    expect(loaded).toBe(false);
    expect(useOpenCodeMobileStore.getState().machineContracts).toEqual({});
  });

  it('creates a session on the chosen machine and puts it at the top of the list', async () => {
    const created = { id: 'ses_new', title: 'New Session', directory: '/repo', time: { created: 2, updated: 2 } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(created), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { useOpenCodeMobileStore } = await import('./mobile-store');
    useOpenCodeMobileStore.setState({ connections: [host], activeConnectionId: host.id, sessions: {} });

    const ref = await useOpenCodeMobileStore.getState().createSession({
      connectionId: host.id,
      relayTargetID: 'mac',
      directory: '/repo',
      title: 'New Session',
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(ref).toMatchObject({ connectionId: host.id, relayTargetID: 'mac', sessionId: 'ses_new' });
    const stored = useOpenCodeMobileStore.getState().sessions[host.id] ?? [];
    expect(stored.map((session) => session.id)).toContain('ses_new');
    // The session has to carry the machine it was created on, or later requests
    // would be routed to whichever backend answers first.
    expect(stored.find((session) => session.id === 'ses_new')?.relayTargetID).toBe('mac');
  });

  it('reports a refused creation instead of returning a ref to nothing', async () => {
    const fetchMock = vi.fn(async () => new Response('no', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const { useOpenCodeMobileStore } = await import('./mobile-store');
    useOpenCodeMobileStore.setState({ connections: [host], activeConnectionId: host.id, sessions: {} });

    const ref = await useOpenCodeMobileStore.getState().createSession({ connectionId: host.id, relayTargetID: 'mac' });

    expect(ref).toBeNull();
    expect(useOpenCodeMobileStore.getState().error).toBeTruthy();
    expect(useOpenCodeMobileStore.getState().sessions[host.id] ?? []).toEqual([]);
  });

  it('forks a session and keeps the fork on the machine it came from', async () => {
    const forked = { id: 'ses_fork', title: 'Fork', directory: '/repo', time: { created: 3, updated: 3 } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(forked), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { useOpenCodeMobileStore } = await import('./mobile-store');
    const ref = { connectionId: host.id, relayTargetID: 'mac', sessionId: 'session-1' };
    useOpenCodeMobileStore.setState({
      connections: [host],
      activeConnectionId: host.id,
      sessions: { [host.id]: [{ id: ref.sessionId, relayTargetID: 'mac', directory: '/repo' } as Session] },
    });

    await expect(useOpenCodeMobileStore.getState().forkSession(ref, 'message-1')).resolves.toBe('ses_fork');

    expect(fetchMock).toHaveBeenCalled();
    const stored = useOpenCodeMobileStore.getState().sessions[host.id] ?? [];
    expect(stored.find((session) => session.id === 'ses_fork')?.relayTargetID).toBe('mac');
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
      'POST /session/session-1/permissions/permission-1',
      'POST /question/question-1/reply',
      'POST /question/question-2/reject',
    ]));
    expect(routedMutations.some((entry) => entry.endsWith('/session/session-1/fork'))).toBe(false);
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

describe('error events from the machine', () => {
  it('reads the message out of the shape the server actually sends', async () => {
    // A failed turn arrives as an event, not as a failed request. The server's
    // shape is { name, data: { message } }.
    const { serverEventErrorText } = await import('./mobile-store');

    expect(serverEventErrorText({
      error: { name: 'UnknownError', data: { message: 'model gpt-9 is not available' } },
    })).toBe('model gpt-9 is not available');
  });

  it('falls back through the shapes an older or newer server might use', async () => {
    const { serverEventErrorText } = await import('./mobile-store');

    expect(serverEventErrorText({ error: { message: 'boom' } })).toBe('boom');
    expect(serverEventErrorText({ message: 'flat message' })).toBe('flat message');
    expect(serverEventErrorText({ error: { name: 'RateLimited' } })).toBe('RateLimited');
  });

  it('says something rather than nothing when the shape is unrecognised', async () => {
    // Silence is the bug being fixed: an unreadable error must not read as
    // "the machine simply produced no output".
    const { serverEventErrorText } = await import('./mobile-store');

    expect(serverEventErrorText({ error: { code: 42 } })).toContain('no description');
  });

  it('ignores an empty string, which would otherwise render as no error at all', async () => {
    const { serverEventErrorText } = await import('./mobile-store');

    expect(serverEventErrorText({ error: { message: '   ', name: 'ProviderError' } }))
      .toBe('ProviderError');
  });
});
