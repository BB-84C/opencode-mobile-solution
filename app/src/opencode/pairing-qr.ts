import { normalizePairingOrigin } from '@/src/opencode/pairing';

export interface RelayPairingQr {
  origin: string;
  code: string;
}

const invalidPairingQr = () => new Error('This is not an OpenCode relay pairing QR code');

export function parseRelayPairingQr(value: string): RelayPairingQr {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidPairingQr();
  }

  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/pair/mobile'
    || parsed.search
    || !parsed.hash.startsWith('#')
  ) {
    throw invalidPairingQr();
  }

  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const entries = [...fragment.entries()];
  const code = fragment.get('code');
  if (entries.length !== 1 || entries[0]?.[0] !== 'code' || !code || code.length < 24) {
    throw invalidPairingQr();
  }

  try {
    return { origin: normalizePairingOrigin(parsed.origin), code };
  } catch {
    throw invalidPairingQr();
  }
}
