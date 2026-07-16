import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { HostConnection } from '@/src/opencode/types';

const CONNECTIONS_KEY = 'opencode-mobile.connections.v1';
const ACTIVE_CONNECTION_KEY = 'opencode-mobile.activeConnection.v1';
const secretKey = (id: string, field: 'token' | 'password') => `opencode-mobile.connection.${id}.${field}`;

type PersistedConnection = Omit<HostConnection, 'token' | 'password'> & {
  hasToken?: boolean;
  hasPassword?: boolean;
};

export async function loadConnections(): Promise<HostConnection[]> {
  const raw = await getStoredConnections();
  if (!raw) return [];
  const items = JSON.parse(raw) as PersistedConnection[];
  return Promise.all(
    items.map(async ({ hasToken, hasPassword, ...item }) => ({
      ...item,
      token: hasToken ? (await getSecret(item.id, 'token')) ?? undefined : undefined,
      password: hasPassword ? (await getSecret(item.id, 'password')) ?? undefined : undefined,
    })),
  );
}

export async function saveConnections(connections: HostConnection[]) {
  for (const connection of connections) {
    if (connection.token) await setSecret(connection.id, 'token', connection.token);
    if (connection.password) await setSecret(connection.id, 'password', connection.password);
  }

  const metadata: PersistedConnection[] = connections.map(({ token, password, ...connection }) => ({
    ...connection,
    hasToken: Boolean(token),
    hasPassword: Boolean(password),
  }));
  await setStoredConnections(JSON.stringify(metadata));
}

export async function removeConnectionSecrets(id: string) {
  await Promise.all([deleteSecret(id, 'token'), deleteSecret(id, 'password')]);
}

export async function loadActiveConnectionId() {
  if (Platform.OS === 'web') return webGetItem(ACTIVE_CONNECTION_KEY);
  return AsyncStorage.getItem(ACTIVE_CONNECTION_KEY);
}

export async function saveActiveConnectionId(id: string | null) {
  if (Platform.OS === 'web') {
    if (id) webSetItem(ACTIVE_CONNECTION_KEY, id);
    else webRemoveItem(ACTIVE_CONNECTION_KEY);
    return;
  }
  if (id) await AsyncStorage.setItem(ACTIVE_CONNECTION_KEY, id);
  else await AsyncStorage.removeItem(ACTIVE_CONNECTION_KEY);
}

async function getSecret(id: string, field: 'token' | 'password') {
  if (shouldUseWebSecretStorage()) return webGetItem(secretKey(id, field));
  try {
    const value = await SecureStore.getItemAsync(secretKey(id, field));
    return value ?? AsyncStorage.getItem(secretKey(id, field));
  } catch {
    return AsyncStorage.getItem(secretKey(id, field));
  }
}

async function getStoredConnections() {
  if (Platform.OS === 'web') return webGetItem(CONNECTIONS_KEY);
  return AsyncStorage.getItem(CONNECTIONS_KEY);
}

async function setStoredConnections(value: string) {
  if (Platform.OS === 'web') {
    webSetItem(CONNECTIONS_KEY, value);
    return;
  }
  await AsyncStorage.setItem(CONNECTIONS_KEY, value);
}

async function setSecret(id: string, field: 'token' | 'password', value: string) {
  if (shouldUseWebSecretStorage()) {
    webSetItem(secretKey(id, field), value);
    return;
  }
  try {
    const key = secretKey(id, field);
    await SecureStore.setItemAsync(key, value);
    const verifiedValue = await SecureStore.getItemAsync(key);
    if (verifiedValue === value) await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, value);
  } catch {
    await AsyncStorage.setItem(secretKey(id, field), value);
  }
}

async function deleteSecret(id: string, field: 'token' | 'password') {
  if (shouldUseWebSecretStorage()) {
    webRemoveItem(secretKey(id, field));
    return;
  }
  try {
    await SecureStore.deleteItemAsync(secretKey(id, field));
  } finally {
    await AsyncStorage.removeItem(secretKey(id, field));
  }
}

function shouldUseWebSecretStorage() {
  return (
    Platform.OS === 'web' ||
    typeof SecureStore.getItemAsync !== 'function' ||
    typeof SecureStore.setItemAsync !== 'function' ||
    typeof SecureStore.deleteItemAsync !== 'function'
  );
}

function webGetItem(key: string) {
  const stored = globalThis.localStorage?.getItem(key);
  if (stored !== undefined && stored !== null) return stored;
  const cookie = webCookieMap().get(key);
  return cookie ? decodeURIComponent(cookie) : null;
}

function webSetItem(key: string, value: string) {
  if (globalThis.localStorage) {
    globalThis.localStorage.setItem(key, value);
    return;
  }
  if (globalThis.document) {
    globalThis.document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=2592000; SameSite=Lax`;
  }
}

function webRemoveItem(key: string) {
  if (globalThis.localStorage) {
    globalThis.localStorage.removeItem(key);
    return;
  }
  if (globalThis.document) {
    globalThis.document.cookie = `${key}=; path=/; max-age=0; SameSite=Lax`;
  }
}

function webCookieMap() {
  return new Map(
    (globalThis.document?.cookie ?? '')
      .split('; ')
      .filter(Boolean)
      .map((item) => {
        const [key, ...value] = item.split('=');
        return [key, value.join('=')] as const;
      }),
  );
}
