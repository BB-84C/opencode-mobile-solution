import { describe, expect, it, vi } from 'vitest';

import { exchangePairingCode, normalizePairingOrigin } from './pairing';

describe('relay phone pairing', () => {
  it('accepts HTTPS relay origins without paths and normalizes a trailing slash', () => {
    expect(normalizePairingOrigin('https://opencode.example.com/')).toBe('https://opencode.example.com');
    expect(() => normalizePairingOrigin('http://opencode.example.com')).toThrow(/HTTPS/i);
    expect(() => normalizePairingOrigin('https://opencode.example.com/admin')).toThrow(/origin/i);
  });

  it('exchanges a one-time code without sending an Authorization header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        connection: {
          name: 'Siyu iPhone',
          url: 'https://opencode.example.com',
          authType: 'bearer',
          token: 'a'.repeat(64),
          clientID: 'phone-1234',
          displayNameRevision: 1,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await expect(exchangePairingCode({
      origin: 'https://opencode.example.com',
      code: 'pairing-code-with-enough-entropy',
      deviceName: 'Siyu iPhone',
      fetchImpl,
    })).resolves.toEqual({
      name: 'Siyu iPhone',
      url: 'https://opencode.example.com',
      authType: 'bearer',
      token: 'a'.repeat(64),
      clientID: 'phone-1234',
      displayNameRevision: 1,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://opencode.example.com/api/pairing/exchange',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(JSON.stringify(fetchImpl.mock.calls[0][1]?.headers)).not.toContain('Authorization');
  });

  it('rejects malformed or cross-origin pairing responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        connection: {
          name: 'Wrong relay',
          url: 'https://attacker.example',
          authType: 'bearer',
          token: 'a'.repeat(64),
          clientID: 'phone-attacker',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await expect(exchangePairingCode({
      origin: 'https://opencode.example.com',
      code: 'pairing-code-with-enough-entropy',
      fetchImpl,
    })).rejects.toThrow(/origin/i);
  });
});
