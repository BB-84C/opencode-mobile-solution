import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostConnection } from '@/src/opencode/types';

vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

const asyncStorageBacking = new Map<string, string>();
const asyncStorage = {
  getItem: vi.fn((key: string) => Promise.resolve(asyncStorageBacking.get(key) ?? null)),
  setItem: vi.fn((key: string, value: string) => {
    asyncStorageBacking.set(key, value);
    return Promise.resolve();
  }),
  removeItem: vi.fn((key: string) => {
    asyncStorageBacking.delete(key);
    return Promise.resolve();
  }),
};

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorage,
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const storage = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

let cookieValue = '';

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    get cookie() {
      return cookieValue;
    },
    set cookie(value: string) {
      const [pair] = value.split(';');
      const [name, rawValue] = pair.split('=');
      const cookies = new Map(
        cookieValue
          .split('; ')
          .filter(Boolean)
          .map((item) => {
            const [cookieName, cookieRawValue] = item.split('=');
            return [cookieName, cookieRawValue] as const;
          }),
      );
      if (rawValue === '') cookies.delete(name);
      else cookies.set(name, rawValue);
      cookieValue = Array.from(cookies.entries())
        .map(([cookieName, cookieRawValue]) => `${cookieName}=${cookieRawValue}`)
        .join('; ');
    },
  },
});

describe('connection storage on web', () => {
  beforeEach(() => {
    storage.clear();
    asyncStorageBacking.clear();
    cookieValue = '';
    vi.clearAllMocks();
  });

  it('persists connection metadata and secrets in browser local storage', async () => {
    const { loadConnections, saveActiveConnectionId, loadActiveConnectionId, saveConnections } = await import('./connection-storage');
    const connection: HostConnection = {
      id: 'host-1',
      name: 'Example Relay',
      url: 'https://opencode.example.com',
      authType: 'bearer',
      token: 'secret-token',
      lastConnected: null,
      isReachable: false,
    };

    await saveConnections([connection]);
    const loaded = await loadConnections();

    expect(asyncStorage.setItem).not.toHaveBeenCalled();
    expect(asyncStorage.getItem).not.toHaveBeenCalled();
    expect(loaded).toEqual([connection]);

    await saveActiveConnectionId(connection.id);
    await expect(loadActiveConnectionId()).resolves.toBe(connection.id);
  });

  it('falls back to cookies when browser local storage is unavailable', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: undefined,
    });
    vi.resetModules();
    const { loadConnections, saveConnections } = await import('./connection-storage');
    const connection: HostConnection = {
      id: 'host-cookie',
      name: 'Cookie Host',
      url: 'https://opencode.example.com',
      authType: 'bearer',
      token: 'secret-token',
      lastConnected: '2026-07-09T11:00:00.000Z',
      isReachable: true,
    };

    await saveConnections([connection]);
    const loaded = await loadConnections();

    expect(cookieValue).toContain('opencode-mobile.connections.v1=');
    expect(loaded).toEqual([connection]);

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
  });

  it('falls back when the runtime reports native platform but SecureStore is unavailable', async () => {
    const reactNative = await import('react-native');
    const secureStore = await import('expo-secure-store');
    reactNative.Platform.OS = 'ios';
    vi.mocked(secureStore.setItemAsync).mockRejectedValue(new TypeError('SecureStore unavailable'));
    vi.mocked(secureStore.getItemAsync).mockRejectedValue(new TypeError('SecureStore unavailable'));
    vi.resetModules();
    const { loadConnections, saveConnections } = await import('./connection-storage');
    const connection: HostConnection = {
      id: 'host-no-secure-store',
      name: 'No SecureStore Host',
      url: 'https://opencode.example.com',
      authType: 'bearer',
      token: 'secret-token',
      lastConnected: null,
      isReachable: false,
    };

    await saveConnections([connection]);
    const loaded = await loadConnections();

    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      'opencode-mobile.connection.host-no-secure-store.token',
      'secret-token',
    );
    expect(loaded).toEqual([connection]);
    reactNative.Platform.OS = 'web';
  });

  it('keeps a native fallback when SecureStore accepts a write but cannot read it back', async () => {
    const reactNative = await import('react-native');
    const secureStore = await import('expo-secure-store');
    reactNative.Platform.OS = 'ios';
    vi.mocked(secureStore.setItemAsync).mockResolvedValue(undefined);
    vi.mocked(secureStore.getItemAsync).mockResolvedValue(null);
    vi.resetModules();
    const { loadConnections, saveConnections } = await import('./connection-storage');
    const connection: HostConnection = {
      id: 'host-null-secure-store',
      name: 'Null SecureStore Host',
      url: 'https://opencode.example.com',
      authType: 'bearer',
      token: 'secret-token',
      lastConnected: null,
      isReachable: false,
    };

    await saveConnections([connection]);
    await expect(loadConnections()).resolves.toEqual([connection]);
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      'opencode-mobile.connection.host-null-secure-store.token',
      'secret-token',
    );
    reactNative.Platform.OS = 'web';
  });

  it('removes the active connection id on native when saving null', async () => {
    const reactNative = await import('react-native');
    reactNative.Platform.OS = 'ios';
    vi.resetModules();
    const { loadActiveConnectionId, saveActiveConnectionId } = await import('./connection-storage');

    await saveActiveConnectionId('host-native');
    await expect(loadActiveConnectionId()).resolves.toBe('host-native');

    await saveActiveConnectionId(null);

    expect(asyncStorage.removeItem).toHaveBeenCalledWith('opencode-mobile.activeConnection.v1');
    await expect(loadActiveConnectionId()).resolves.toBeNull();
    reactNative.Platform.OS = 'web';
  });
});
