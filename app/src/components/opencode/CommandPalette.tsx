import { router } from 'expo-router';
import { useMemo } from 'react';

import { useOpenCodeMobileStore } from '@/src/store/mobile-store';
import { buildCommandPalette, type PaletteEntry } from '@/src/ux/command-palette';
import { ActionModal, type ActionItem } from './ActionModal';

/**
 * The palette every surface can reach, by key on the desktop and by button on a
 * phone. A session screen claims the same key for its own richer palette while
 * it is mounted, so this one answers everywhere else.
 */
export function CommandPalette() {
  const open = useOpenCodeMobileStore((state) => state.commandPaletteOpen);
  const close = useOpenCodeMobileStore((state) => state.closeCommandPalette);
  const activeSessionRef = useOpenCodeMobileStore((state) => state.activeSessionRef);
  const activeSessionKey = useOpenCodeMobileStore((state) => state.activeSessionKey);
  const connections = useOpenCodeMobileStore((state) => state.connections);
  const showNotice = useOpenCodeMobileStore((state) => state.showNotice);

  const entries = useMemo(
    () => buildCommandPalette({ hasSession: Boolean(activeSessionRef), hasHost: connections.length > 0 }),
    [activeSessionRef, connections.length],
  );

  const items: ActionItem[] = entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    detail: entry.disabledReason ?? entry.detail,
    disabled: Boolean(entry.disabledReason),
    onPress: () => run(entry),
  }));

  function run(entry: PaletteEntry) {
    if (entry.disabledReason) {
      showNotice(entry.disabledReason);
      return;
    }
    if (entry.effect.kind === 'navigate') {
      router.push(entry.effect.path as never);
      return;
    }
    if (entry.effect.kind === 'open-session') {
      if (!activeSessionKey) return;
      router.push({ pathname: '/session/[sessionKey]', params: { sessionKey: activeSessionKey } });
    }
  }

  return (
    <ActionModal
      title="Commands"
      visible={open}
      items={items}
      onClose={close}
      onActionError={(error) => showNotice(error instanceof Error ? error.message : String(error))}
    />
  );
}
