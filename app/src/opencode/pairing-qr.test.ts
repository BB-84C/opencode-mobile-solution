import { describe, expect, it } from 'vitest';

import { parseRelayPairingQr } from '@/src/opencode/pairing-qr';

describe('parseRelayPairingQr', () => {
  it('extracts the relay origin and one-time code from the Dashboard QR URL', () => {
    expect(
      parseRelayPairingQr(
        'https://relay.example.test/pair/mobile#code=0123456789abcdef0123456789abcdef',
      ),
    ).toEqual({
      origin: 'https://relay.example.test',
      code: '0123456789abcdef0123456789abcdef',
    });
  });

  it.each([
    'http://relay.example.test/pair/mobile#code=0123456789abcdef0123456789abcdef',
    'https://relay.example.test/not-pairing#code=0123456789abcdef0123456789abcdef',
    'https://relay.example.test/pair/mobile?code=0123456789abcdef0123456789abcdef',
    'https://relay.example.test/pair/mobile#code=short',
    'https://user:secret@relay.example.test/pair/mobile#code=0123456789abcdef0123456789abcdef',
    'https://relay.example.test/pair/mobile#code=0123456789abcdef0123456789abcdef&next=evil',
    'not a URL',
  ])('rejects a QR that is not an exact HTTPS relay pairing URL: %s', (value) => {
    expect(() => parseRelayPairingQr(value)).toThrow('OpenCode relay pairing QR');
  });
});
