import { describe, expect, it, vi } from 'vitest';

import { OpenCodeClient, buildAuthHeaders } from './client';
import type { HostConnection } from './types';

const bearerConnection: HostConnection = {
  id: 'host-1',
  name: 'Example Relay',
  url: 'https://opencode.example.com',
  authType: 'bearer',
  token: 'secret-token',
  lastConnected: null,
  isReachable: false,
};

describe('buildAuthHeaders', () => {
  it('builds bearer headers without leaking credentials into other fields', () => {
    expect(buildAuthHeaders(bearerConnection)).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret-token',
    });
  });

  it('builds basic headers', () => {
    expect(
      buildAuthHeaders({
        ...bearerConnection,
        authType: 'basic',
        username: 'opencode',
        password: 'pw',
        token: undefined,
      }),
    ).toMatchObject({
      Authorization: 'Basic b3BlbmNvZGU6cHc=',
    });
  });
});

describe('OpenCodeClient', () => {
  it('retries a read after Expo reports the native cancellation caused by our timeout', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        signals.push(init!.signal as AbortSignal);
        if (signals.length > 1) return jsonResponse({ healthy: true });
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error(
            'fetch failed: FetchRequestCanceledException: Fetch request has been canceled (at Expo/NativeResponse.swift:63)',
          )));
        });
      });
      const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock, timeoutMs: 50 });
      const result = client.health();
      await vi.runAllTimersAsync();
      await expect(result).resolves.toEqual({ healthy: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a native body read that never settles and honors the single-attempt status policy', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init!.signal as AbortSignal;
        return { ok: true, text: () => new Promise<string>(() => {}) } as Response;
      });
      const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });
      const result = expect(client.getSessionStatus({ directory: '/private/project' }, { timeoutMs: 50, retry: false }))
        .rejects.toThrow('OpenCode request timed out after 1s (GET /session/status)');
      await vi.runAllTimersAsync();
      await result;
      expect(signal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries Expo transport failures but never retries a timed-out mutation', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('fetch failed: connection interrupted'))
        .mockResolvedValueOnce(jsonResponse({ healthy: true }));
      const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock, timeoutMs: 50 });
      const health = client.health();
      await vi.runAllTimersAsync();
      await expect(health).resolves.toEqual({ healthy: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockReset().mockImplementation(() => new Promise<Response>(() => {}));
      const mutation = expect(client.createSession('Test', '/repo')).rejects.toThrow('timed out');
      await vi.runAllTimersAsync();
      await mutation;
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('binds the default browser fetch implementation', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new Error('fetch called without browser global receiver');
      return Promise.resolve(jsonResponse({ healthy: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const client = new OpenCodeClient(bearerConnection);

      await expect(client.health()).resolves.toEqual({ healthy: true });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('rejects plaintext http in release mode', async () => {
    const client = new OpenCodeClient(
      { ...bearerConnection, url: 'http://example.test' },
      { release: true, fetch: vi.fn() },
    );

    await expect(client.health()).rejects.toThrow('HTTPS is required');
  });

  it('condenses gateway HTML into a useful bounded error instead of rendering the page source', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: new Headers({ 'content-type': 'text/html; charset=UTF-8' }),
      text: async () => '<!DOCTYPE html><html><head><title>502: Bad gateway</title></head><body>huge proxy page</body></html>',
    }) as Response);
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await expect(client.health()).rejects.toThrow('OpenCode request failed (502): Bad Gateway');
    await expect(client.health()).rejects.not.toThrow('<!DOCTYPE');
  });

  it('keeps a relay usable when its default machine is down but another authorized target is healthy', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/relay/targets')) {
        return jsonResponse({ targets: [{ id: 'windows', name: 'Windows' }, { id: 'mac', name: 'MacBook' }] });
      }
      const target = new Headers(init?.headers).get('X-OpenCode-Target');
      if (url.endsWith('/global/health') && target === 'windows') {
        return jsonResponse({ error: 'upstream unavailable' }, 502);
      }
      if (url.endsWith('/global/health') && target === 'mac') {
        return jsonResponse({ healthy: true, version: '1.17.18' });
      }
      throw new Error(`unexpected request ${url} target=${target}`);
    });
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await expect(client.healthAcrossRelayTargets(new Error('default target down'))).resolves.toEqual({
      healthy: true,
      version: '1.17.18',
    });
  });

  it('calls OpenCode REST endpoints with bearer auth', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.17.14' });
      }
      if (url.endsWith('/api/session?limit=1000')) {
        return jsonResponse({
          data: [{ id: 's1', title: 'Test', location: { directory: 'D:\\workspace' }, time: { created: 1, updated: 2 } }],
          cursor: {},
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await expect(client.health()).resolves.toEqual({ healthy: true, version: '1.17.14' });
    await expect(client.listSessions()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/global/health',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
      }),
    );
  });

  it('fully enumerates host sessions with keyset pagination and normalizes their machine directories', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `mac-${index}`,
      title: `Mac ${index}`,
      location: { directory: index % 2 === 0 ? '/Users/example' : '/Users/example/Documents/GitHub' },
      time: { created: 200 - index, updated: 300 - index },
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/session?limit=1000')) {
        return jsonResponse({ data: firstPage, cursor: { next: 'next page+/=' } });
      }
      if (url.endsWith('/api/session?limit=1000&cursor=next+page%2B%2F%3D')) {
        return jsonResponse({
          data: [
            {
              id: 'windows-session',
              title: 'Windows work',
              location: { directory: 'D:\\workspace\\project' },
              time: { created: 1, updated: 2 },
            },
          ],
          cursor: {},
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    const sessions = await client.listSessions();

    expect(sessions).toHaveLength(101);
    expect(sessions[0]).toMatchObject({ id: 'mac-0', directory: '/Users/example' });
    expect(sessions.at(-1)).toMatchObject({
      id: 'windows-session',
      directory: 'D:\\workspace\\project',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('discovers every authorized relay machine and tags sessions with their routing identity', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/relay/targets')) {
        return jsonResponse({
          targets: [
            { id: 'windows', name: 'Windows workstation' },
            { id: 'mac', name: 'MacBook' },
          ],
        });
      }
      if (url.endsWith('/api/session?limit=1000')) {
        const targetID = new Headers(init?.headers).get('X-OpenCode-Target');
        return jsonResponse({
          data: [
            targetID === 'windows'
              ? { id: 'win-session', location: { directory: 'D:\\work' }, time: { updated: 2 } }
              : { id: 'mac-session', location: { directory: '/Users/example/work' }, time: { updated: 1 } },
          ],
          cursor: {},
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await expect(client.listSessionsAcrossRelayTargets()).resolves.toEqual([
      expect.objectContaining({
        id: 'win-session',
        directory: 'D:\\work',
        relayTargetID: 'windows',
        relayTargetName: 'Windows workstation',
      }),
      expect.objectContaining({
        id: 'mac-session',
        directory: '/Users/example/work',
        relayTargetID: 'mac',
        relayTargetName: 'MacBook',
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/api/session?limit=1000',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-OpenCode-Target': 'windows' }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/api/session?limit=1000',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-OpenCode-Target': 'mac' }) }),
    );
  });

  it('routes follow-up session operations to the machine selected by the store', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'win-session', title: 'Renamed' }));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock, relayTargetID: 'windows' });

    await client.updateSession('win-session', { title: 'Renamed' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/session/win-session',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ 'X-OpenCode-Target': 'windows' }),
      }),
    );
  });

  it('loads agents, commands, and configured model variants from the selected machine and directory', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/agent?')) return jsonResponse([{ name: 'build', mode: 'primary', model: null }]);
      if (url.includes('/command?')) return jsonResponse([{ name: 'review' }]);
      if (url.includes('/config/providers?')) {
        return jsonResponse({
          providers: [
            {
              id: 'openai',
              name: 'OpenAI',
              models: {
                'gpt-5.5': {
                  id: 'gpt-5.5',
                  providerID: 'openai',
                  variants: { minimal: {}, xhigh: {} },
                },
              },
            },
          ],
          default: { openai: 'gpt-5.5' },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const client = new OpenCodeClient(bearerConnection, {
      fetch: fetchMock,
      relayTargetID: 'mac-opencode',
    });

    await expect(client.listAgents({ directory: '/Users/example/Documents/GitHub' })).resolves.toHaveLength(1);
    await expect(client.listCommands({ directory: '/Users/example/Documents/GitHub' })).resolves.toHaveLength(1);
    await expect(client.listConfiguredProviders({ directory: '/Users/example/Documents/GitHub' })).resolves.toMatchObject({
      default: { openai: 'gpt-5.5' },
      providers: [{ models: { 'gpt-5.5': { variants: { minimal: {}, xhigh: {} } } } }],
    });

    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('X-OpenCode-Target')).toBe('mac-opencode');
      expect(new Headers(init?.headers).get('X-OpenCode-Directory')).toBe('/Users/example/Documents/GitHub');
    }
  });

  it('rejects prompt_async when the verified dispatch contract is incomplete', async () => {
    const fetchMock = vi.fn(async () => emptyResponse(204));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await expect(client.sendAsync('session-1', [{ type: 'text', text: 'Say hello.' }])).rejects.toThrow(
      'agent, model, and directory',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('walks every bounded message page and extracts only the cursor from an internal Link URL', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/session/session-1/message?limit=50')) {
        return jsonResponse(
          [
            { info: { id: 'new-1', role: 'user' }, parts: [{ type: 'text', text: 'new one' }] },
            { info: { id: 'new-2', role: 'assistant' }, parts: [{ type: 'text', text: 'new two' }] },
          ],
          200,
          {
            Link: '<https://127.0.0.1:4096/session/session-1/message?limit=50&before=cursor-from-link>; rel="next"',
          },
        );
      }
      if (url.endsWith('/session/session-1/message?limit=50&before=cursor-from-link')) {
        return jsonResponse([
          { info: { id: 'old-1', role: 'user' }, parts: [{ type: 'text', text: 'old one' }] },
          { info: { id: 'old-2', role: 'assistant' }, parts: [{ type: 'text', text: 'old two' }] },
        ]);
      }
      throw new Error(`unexpected url ${url}`);
    });
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await expect(client.listMessages('session-1')).resolves.toEqual([
      expect.objectContaining({ info: expect.objectContaining({ id: 'old-1' }) }),
      expect.objectContaining({ info: expect.objectContaining({ id: 'old-2' }) }),
      expect.objectContaining({ info: expect.objectContaining({ id: 'new-1' }) }),
      expect.objectContaining({ info: expect.objectContaining({ id: 'new-2' }) }),
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://opencode.example.com/session/session-1/message?limit=50',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://opencode.example.com/session/session-1/message?limit=50&before=cursor-from-link',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }) }),
    );
  });

  it('rejects a repeated message cursor instead of looping forever', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([], 200, {
      'X-Next-Cursor': 'same-cursor',
    }));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await expect(client.listMessages('session-1', 50, 'same-cursor')).rejects.toThrow('repeated cursor');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends prompt_async with selected agent, model, and variant when provided', async () => {
    const fetchMock = vi.fn(async () => emptyResponse(204));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await client.sendAsync(
      'session-1',
      [{ type: 'text', text: 'Say hello.' }],
      {
        agent: 'orchestrator',
        model: { providerID: 'openai', modelID: 'gpt-5' },
        variant: 'high',
        directory: 'D:\\workspace',
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/session/session-1/prompt_async?directory=D%3A%5Cworkspace',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-OpenCode-Directory': 'D:\\workspace' }),
        body: JSON.stringify({
          parts: [{ type: 'text', text: 'Say hello.' }],
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'gpt-5' },
          variant: 'high',
        }),
      }),
    );
  });

  it('dispatches slash commands through the OpenCode command endpoint', async () => {
    const fetchMock = vi.fn(async () => emptyResponse(204));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await client.sendCommand('session-1', 'share', '--public', {
      agent: 'orchestrator',
      model: { providerID: 'openai', modelID: 'gpt-5' },
      variant: 'high',
      directory: 'D:\\workspace',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/session/session-1/command?directory=D%3A%5Cworkspace',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-OpenCode-Directory': 'D:\\workspace' }),
        body: JSON.stringify({
          command: 'share',
          arguments: '--public',
          agent: 'orchestrator',
          model: 'openai/gpt-5',
          variant: 'high',
        }),
      }),
    );
  });

  it('dispatches shell mode through the OpenCode shell endpoint', async () => {
    const fetchMock = vi.fn(async () => emptyResponse(204));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await client.runShell('session-1', 'ls -la', {
      agent: 'orchestrator',
      model: { providerID: 'openai', modelID: 'gpt-5' },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/session/session-1/shell',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          command: 'ls -la',
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'gpt-5' },
        }),
      }),
    );
  });

  it('updates, shares, forks, compacts, reverts, and unreverts sessions through the OpenCode session API', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'session-1', title: 'Updated title' }));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await client.updateSession('session-1', { title: 'Updated title' });
    await client.shareSession('session-1');
    await client.forkSession('session-1', 'msg_123');
    await client.compactSession('session-1', { providerID: 'openai', modelID: 'gpt-5' });
    await client.revertMessage('session-1', 'msg_123');
    await client.unrevertSession('session-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/session/session-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Updated title' }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/session/session-1/share',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/session/session-1/fork',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ messageID: 'msg_123' }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/session/session-1/summarize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ providerID: 'openai', modelID: 'gpt-5', auto: false }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/session/session-1/revert',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ messageID: 'msg_123' }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/session/session-1/unrevert',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('loads session todos from the OpenCode todo endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([{ content: 'Review mobile transcript', status: 'pending', priority: 'high' }]),
    );
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await expect(client.getSessionTodos('session-1')).resolves.toEqual([
      { content: 'Review mobile transcript', status: 'pending', priority: 'high' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/session/session-1/todo',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('loads active session context from the v2 context endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ type: 'user', id: 'ctx_1' }] }));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await expect(client.getSessionContext('session-1')).resolves.toEqual([{ type: 'user', id: 'ctx_1' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/api/session/session-1/context',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('loads LSP and MCP status with workspace query parameters', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://opencode.example.com/lsp?')) return jsonResponse([{ id: 'tsserver', status: 'running' }]);
      if (url.startsWith('https://opencode.example.com/mcp?')) {
        return jsonResponse({ playwright: { status: 'connected' }, grep_app: { status: 'disconnected' } });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await expect(client.getLspStatus({ directory: 'D:/repo', workspace: 'ws_1' })).resolves.toEqual([
      { id: 'tsserver', status: 'running' },
    ]);
    await expect(client.getMcpStatus({ directory: 'D:/repo', workspace: 'ws_1' })).resolves.toEqual({
      playwright: { status: 'connected' },
      grep_app: { status: 'disconnected' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/lsp?directory=D%3A%2Frepo&workspace=ws_1',
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/mcp?directory=D%3A%2Frepo&workspace=ws_1',
      expect.any(Object),
    );
  });

  it('finds file references through the OpenCode find endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(['package.json', 'src/app.ts']));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await expect(client.findFiles('package', { limit: 5, type: 'file' })).resolves.toEqual([
      { path: 'package.json' },
      { path: 'src/app.ts' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/find/file?query=package&limit=5&type=file',
      expect.any(Object),
    );
  });

  it('loads standalone permission gates and replies with the current scoped API contract', async () => {
    const request = { id: 'per_123', sessionID: 'ses_1', permission: 'external_directory', patterns: ['/etc/*'], metadata: { command: 'cat /etc/hosts' }, always: ['/etc/*'] };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      jsonResponse(init?.method === 'POST' ? true : [request]));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock, relayTargetID: 'mac' });
    const query = { directory: '/Users/test', workspace: 'ws_1' };
    await expect(client.listPermissions(query)).resolves.toEqual([request]);
    await client.respondToPermission('ses_1', request.id, { reply: 'reject', message: 'Stay in the workspace' }, query);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://opencode.example.com/permission?directory=%2FUsers%2Ftest&workspace=ws_1',
      'https://opencode.example.com/permission/per_123/reply?directory=%2FUsers%2Ftest&workspace=ws_1',
    ]);
    const init = fetchMock.mock.calls[1][1];
    expect(new Headers(init?.headers).get('X-OpenCode-Target')).toBe('mac');
    expect(new Headers(init?.headers).get('X-OpenCode-Directory')).toBe('/Users/test');
    expect(JSON.parse(String(init?.body))).toEqual({ reply: 'reject', message: 'Stay in the workspace' });
  });

  it('does not replay a permission decision after a transport failure', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });
    await expect(client.respondToPermission('ses_1', 'per_1', { reply: 'once' }, { directory: '/repo' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('replies to OpenCode question requests with answers matrix', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await client.respondToQuestion('que_123', { answers: [['staging', 'production']] }, { directory: 'D:\\workspace' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/question/que_123/reply?directory=D%3A%5Cworkspace',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ answers: [['staging', 'production']] }),
        headers: expect.objectContaining({ 'X-OpenCode-Directory': 'D:\\workspace' }),
      }),
    );
  });

  it('rejects OpenCode question requests', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await client.rejectQuestion('que_123', { directory: 'D:\\workspace' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/question/que_123/reject?directory=D%3A%5Cworkspace',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-OpenCode-Directory': 'D:\\workspace' }),
      }),
    );
  });

  it('lists pending question requests for the active workspace', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        {
          id: 'que_123',
          sessionID: 's1',
          questions: [{ header: 'Target', question: 'Choose target', options: [] }],
        },
      ]),
    );
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await expect(client.listQuestions({ directory: 'D:\\workspace' })).resolves.toEqual([
      {
        id: 'que_123',
        sessionID: 's1',
        questions: [{ header: 'Target', question: 'Choose target', options: [] }],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/question?directory=D%3A%5Cworkspace',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-OpenCode-Directory': 'D:\\workspace' }) }),
    );
  });

  it('subscribes to SSE events and aborts the stream on unsubscribe', async () => {
    const chunks = [
      new TextEncoder().encode('event: server.connected\ndata: {"version":"1.2.3"}\n\n'),
      new TextEncoder().encode('event: message.updated\ndata: {"sessionID":"s1"}\n\n'),
    ];
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: chunks[0] })
      .mockResolvedValueOnce({ done: false, value: chunks[1] })
      .mockImplementationOnce(() => new Promise(() => undefined));
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({ read }),
        },
        text: async () => '',
      } as unknown as Response;
    });
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });
    const events: unknown[] = [];

    const unsubscribe = client.subscribeEvents((event) => events.push(event));
    await eventually(() => {
      expect(events).toEqual([
        { type: 'server.connected', version: '1.2.3' },
        { type: 'message.updated', sessionID: 's1' },
      ]);
    });
    unsubscribe();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/event',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
      }),
    );
    expect(signal?.aborted).toBe(true);
  });

  it('reconnects an ended SSE stream and invokes the refetch boundary only after the new stream connects', async () => {
    const firstRead = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode('event: server.connected\ndata: {}\n\n'),
      })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const secondRead = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode('event: server.connected\ndata: {}\n\n'),
      })
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode('event: message.updated\ndata: {"sessionID":"s1"}\n\n'),
      })
      .mockImplementationOnce(() => new Promise(() => undefined));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse(firstRead))
      .mockResolvedValueOnce(streamResponse(secondRead));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });
    const events: unknown[] = [];
    const onReconnect = vi.fn(async () => undefined);

    const unsubscribe = client.subscribeEvents((event) => events.push(event), {
      reconnectDelayMs: 0,
      onReconnect,
      directory: 'D:\\workspace',
    });
    await eventually(() => {
      expect(events).toEqual([
        { type: 'server.connected' },
        { type: 'server.connected' },
        { type: 'message.updated', sessionID: 's1' },
      ]);
    });
    unsubscribe();

    expect(onReconnect).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.example.com/event?directory=D%3A%5Cworkspace',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-OpenCode-Directory': 'D:\\workspace' }),
      }),
    );
  });

  it('does not reconnect forever when the event credential is rejected', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });
    const onConnectionState = vi.fn();

    client.subscribeEvents(() => undefined, { reconnectDelayMs: 0, onConnectionState });
    await eventually(() => {
      expect(onConnectionState).toHaveBeenCalledWith('offline', expect.objectContaining({ status: 401 }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OpenCodeClient.createSession', () => {
  const serverPlaceholder = /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  function createdSession() {
    return { id: 'ses_new', title: 'New session - 2026-09-24T07:30:15.250Z', directory: '/repo' };
  }

  function bodyOf(fetchMock: ReturnType<typeof vi.fn>) {
    const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    return JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
  }

  it('omits the title so the server can auto-name the session', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(createdSession()));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await client.createSession(undefined, '/repo');

    expect(bodyOf(fetchMock)).toEqual({});
  });

  it('keeps a title the caller chose', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(createdSession()));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    await client.createSession('Quarterly review', '/repo');

    expect(bodyOf(fetchMock)).toEqual({ title: 'Quarterly review' });
  });

  it('leaves the server placeholder in place, so the server can still rename it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(createdSession()));
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    const session = await client.createSession(undefined, '/repo');

    expect('title' in bodyOf(fetchMock)).toBe(false);
    expect(session.title).toMatch(serverPlaceholder);
  });

  it('still refuses to create a session without a directory', () => {
    const fetchMock = vi.fn();
    const client = new OpenCodeClient(bearerConnection, { fetch: fetchMock });

    expect(() => client.createSession()).toThrow('requires a directory');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

async function eventually(assertion: () => void) {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function jsonResponse(body: unknown, status = 200, responseHeaders: Record<string, string> = {}) {
  const headers = new Headers(responseHeaders);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => '',
    json: async () => undefined,
  } as Response;
}

function streamResponse(read: () => Promise<{ done: boolean; value: Uint8Array | undefined }>) {
  return {
    ok: true,
    status: 200,
    body: { getReader: () => ({ read }) },
    text: async () => '',
  } as unknown as Response;
}
