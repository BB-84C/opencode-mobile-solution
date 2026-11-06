import { describe, expect, it } from 'vitest';

import { buildCommandPalette } from './command-palette';

const ids = (entries: ReturnType<typeof buildCommandPalette>) => entries.map((entry) => entry.id);

describe('command palette', () => {
  it('offers the same entries whether or not a session is open', () => {
    // A phone reaches these actions only through this list, so an entry that
    // disappears is a feature the touch user cannot get to at all. Entries stay
    // and explain themselves instead.
    const withSession = ids(buildCommandPalette({ hasSession: true, hasHost: true }));
    const without = ids(buildCommandPalette({ hasSession: false, hasHost: false }));

    expect(without).toEqual(withSession);
  });

  it('says why an entry cannot run rather than hiding it', () => {
    const entries = buildCommandPalette({ hasSession: false, hasHost: true });
    const current = entries.find((entry) => entry.id === 'current-session');

    expect(current?.disabledReason).toBe('Open a session first');
  });

  it('enables session entries once a session is open', () => {
    const entries = buildCommandPalette({ hasSession: true, hasHost: true });

    expect(entries.find((entry) => entry.id === 'current-session')?.disabledReason).toBeUndefined();
  });

  it('blocks host-dependent entries until a host is paired', () => {
    const entries = buildCommandPalette({ hasSession: false, hasHost: false });

    for (const id of ['sessions', 'new-session', 'machines']) {
      expect(entries.find((entry) => entry.id === id)?.disabledReason).toBe('Pair a host first');
    }
  });

  it('always leaves a way to reach hosts and settings, even with nothing paired', () => {
    // Otherwise a device with no host has an empty palette and no way back.
    const entries = buildCommandPalette({ hasSession: false, hasHost: false });

    expect(entries.find((entry) => entry.id === 'hosts')?.disabledReason).toBeUndefined();
    expect(entries.find((entry) => entry.id === 'settings')?.disabledReason).toBeUndefined();
  });

  it('routes every entry somewhere', () => {
    for (const entry of buildCommandPalette({ hasSession: true, hasHost: true })) {
      expect(entry.effect.kind).toBeTruthy();
      if (entry.effect.kind === 'navigate') expect(entry.effect.path.startsWith('/')).toBe(true);
    }
  });
});
