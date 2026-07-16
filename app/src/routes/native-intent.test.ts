import { describe, expect, it } from 'vitest';

import { redirectSystemPath } from '@/app/+native-intent';

describe('Expo native intent route handoff', () => {
  it('redirects App Intent URLs into the mobile router contract', () => {
    expect(redirectSystemPath({ path: 'opencode://workbench', initial: true })).toBe('/two');
    expect(redirectSystemPath({ path: 'opencode://session/ses_123', initial: true })).toBe('opencode://session/ses_123');
    expect(redirectSystemPath({ path: 'opencode://prompt?text=Run%20tests', initial: true })).toBe('opencode://prompt?text=Run%20tests');
    expect(
      redirectSystemPath({
        path: 'opencode://pair?origin=https%3A%2F%2Fopencode.example.com&code=one-time-code',
        initial: true,
      }),
    ).toBe('/pair?origin=https%3A%2F%2Fopencode.example.com&code=one-time-code');
  });

  it('leaves ordinary in-app paths untouched', () => {
    expect(redirectSystemPath({ path: '/two', initial: true })).toBe('/two');
  });
});
