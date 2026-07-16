export interface PairedConnection {
  name: string;
  url: string;
  authType: 'bearer';
  token: string;
  clientID: string;
  displayNameRevision?: number;
}

interface ExchangePairingOptions {
  origin: string;
  code: string;
  deviceName?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function normalizePairingOrigin(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Pairing relay origin is invalid');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('Pairing relay must be an origin without a path');
  }
  if (parsed.protocol !== 'https:') throw new Error('Pairing requires an HTTPS relay');
  return parsed.origin;
}

export async function exchangePairingCode({
  origin,
  code,
  deviceName = 'OpenCode iPhone',
  fetchImpl = globalThis.fetch.bind(globalThis),
  timeoutMs = 20_000,
}: ExchangePairingOptions): Promise<PairedConnection> {
  const relayOrigin = normalizePairingOrigin(origin);
  if (typeof code !== 'string' || code.length < 24) throw new Error('Pairing code is incomplete');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${relayOrigin}/api/pairing/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName }),
      signal: controller.signal,
    });
    const value = await response.json().catch(() => ({})) as {
      connection?: Partial<PairedConnection>;
      message?: string;
      error?: string;
    };
    if (!response.ok) throw new Error(value.message || value.error || `Pairing failed (${response.status})`);
    const connection = value.connection;
    if (
      !connection
      || connection.authType !== 'bearer'
      || typeof connection.name !== 'string'
      || typeof connection.url !== 'string'
      || typeof connection.token !== 'string'
      || connection.token.length < 32
      || typeof connection.clientID !== 'string'
      || !connection.clientID
    ) throw new Error('Relay returned an invalid pairing credential');
    if (normalizePairingOrigin(connection.url) !== relayOrigin) throw new Error('Pairing response origin does not match the scanned relay');
    return {
      name: connection.name,
      url: relayOrigin,
      authType: 'bearer',
      token: connection.token,
      clientID: connection.clientID,
      displayNameRevision: typeof connection.displayNameRevision === 'number' ? connection.displayNameRevision : undefined,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Pairing timed out; generate a new QR code');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
