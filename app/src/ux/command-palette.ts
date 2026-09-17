/**
 * What the global command palette offers, and when.
 *
 * Kept apart from the component so the contents can be asserted without a
 * renderer. The palette is the only way a phone reaches actions the desktop
 * binds to keys, so an entry that silently disappears on one platform is the
 * failure this module exists to make visible.
 */

export type PaletteEffect =
  | { kind: 'navigate'; path: string }
  | { kind: 'store'; action: 'fork' | 'compact' | 'share' | 'copy-transcript' | 'interrupt' }
  | { kind: 'open-session' };

export interface PaletteEntry {
  id: string;
  label: string;
  detail: string;
  effect: PaletteEffect;
  /** Present when the entry cannot run right now, and why. */
  disabledReason?: string;
}

export function buildCommandPalette(context: {
  hasSession: boolean;
  hasHost: boolean;
}): PaletteEntry[] {
  const needsSession = context.hasSession ? undefined : 'Open a session first';
  const needsHost = context.hasHost ? undefined : 'Pair a host first';

  return [
    {
      id: 'sessions',
      label: 'Sessions',
      detail: 'Every session on the paired machines',
      effect: { kind: 'navigate', path: '/(tabs)/two' },
      disabledReason: needsHost,
    },
    {
      id: 'current-session',
      label: 'Back to current session',
      detail: 'Return to the session you last opened',
      effect: { kind: 'open-session' },
      disabledReason: needsSession,
    },
    {
      id: 'new-session',
      label: 'New session',
      detail: 'Start a session on a machine and directory',
      effect: { kind: 'navigate', path: '/new-session' },
      disabledReason: needsHost,
    },
    {
      id: 'machines',
      label: 'Machines',
      detail: 'Choose which machine to work on',
      effect: { kind: 'navigate', path: '/devices' },
      disabledReason: needsHost,
    },
    {
      id: 'hosts',
      label: 'Hosts',
      detail: 'Add, edit or remove a relay',
      effect: { kind: 'navigate', path: '/(tabs)' },
    },
    {
      id: 'settings',
      label: 'Settings',
      detail: 'Connection, appearance, and session removal',
      effect: { kind: 'navigate', path: '/modal' },
    },
  ];
}
