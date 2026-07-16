import { describe, expect, it } from 'vitest';

import { appIntentDefinitions, appIntentToRoute, parseAppIntentUrl, redirectAppIntentPath } from './app-intents';

describe('App Intent handoff contract', () => {
  it('exposes a narrow first-pass intent surface', () => {
    expect(appIntentDefinitions.map((intent) => intent.id)).toEqual(['open-sessions']);
    expect(appIntentDefinitions.every((intent) => intent.openAppWhenRun)).toBe(true);
  });

  it('parses the sessions handoff and keeps the old workbench URL as a safe alias', () => {
    expect(parseAppIntentUrl('opencode://sessions')).toEqual({ type: 'open-sessions' });
    expect(parseAppIntentUrl('opencode://workbench')).toEqual({ type: 'open-sessions' });
  });

  it('rejects legacy prompt and bare-session handoffs instead of guessing a machine', () => {
    expect(parseAppIntentUrl('opencode://session/ses_123')).toBeNull();
    expect(parseAppIntentUrl('opencode://prompt?text=Run%20tests')).toBeNull();
  });

  it('maps App Intent handoffs to Expo Router paths', () => {
    expect(appIntentToRoute({ type: 'open-sessions' })).toBe('/two');
  });

  it('rewrites external App Intent URLs and leaves non-intent paths alone', () => {
    expect(redirectAppIntentPath('opencode://sessions')).toBe('/two');
    expect(redirectAppIntentPath('opencode://workbench')).toBe('/two');
    expect(redirectAppIntentPath('opencode://prompt?text=Run%20tests')).toBe('opencode://prompt?text=Run%20tests');
    expect(redirectAppIntentPath('/session/ses_123')).toBe('/session/ses_123');
  });
});
