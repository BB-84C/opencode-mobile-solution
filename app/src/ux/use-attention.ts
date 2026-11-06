import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { useOpenCodeMobileStore } from '@/src/store/mobile-store';

import { collectAttention, planAttentionDelivery, unseenAttention, type AttentionItem } from './attention';
import { detectDesktopShellHost } from './desktop-bridge';

/**
 * Keeps every paired machine watched for permissions and questions, and tells
 * the user when one appears: a system notification from the desktop shell
 * (which keeps running in the tray after its window closes), and an in-app
 * banner whenever the open screen is not already showing the request.
 */
export function useAttention() {
  const store = useOpenCodeMobileStore(useShallow((state) => ({
    hydrated: state.hydrated,
    connections: state.connections,
    relayTargets: state.relayTargets,
    permissions: state.permissions,
    questions: state.questions,
    sessionFailures: state.sessionFailures,
    sessions: state.sessions,
    activeSessionKey: state.activeSessionKey,
    startAttentionWatch: state.startAttentionWatch,
    stopAttentionWatch: state.stopAttentionWatch,
    resumeLiveUpdates: state.resumeLiveUpdates,
  })));

  // connections and relayTargets are listed on purpose: the watch reads them
  // from the store itself, and has to re-align whenever either changes.
  useEffect(() => {
    if (store.hydrated) store.startAttentionWatch();
  }, [store.hydrated, store.connections, store.relayTargets, store.startAttentionWatch]);

  useEffect(() => store.stopAttentionWatch, [store.stopAttentionWatch]);

  useEffect(() => {
    // A suspended phone keeps a socket that looks open and delivers nothing.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') store.resumeLiveUpdates();
    });
    return () => subscription.remove();
  }, [store.resumeLiveUpdates]);

  useEffect(() => {
    const host = detectDesktopShellHost();
    if (!host?.onNavigate) return undefined;
    return host.onNavigate((route) => router.push(route as never));
  }, []);

  const items = useMemo(
    () => collectAttention({ permissions: store.permissions, questions: store.questions, sessions: store.sessions, failures: store.sessionFailures }),
    [store.permissions, store.questions, store.sessions, store.sessionFailures],
  );
  const seen = useRef(new Set<string>());
  const [banner, setBanner] = useState<AttentionItem | null>(null);

  useEffect(() => {
    const fresh = unseenAttention(items, seen.current);
    // Remember only what is still pending, so the set cannot grow forever.
    seen.current = new Set(items.map((item) => item.id));
    const host = detectDesktopShellHost();
    const plan = planAttentionDelivery(fresh, { canNotify: Boolean(host?.notify), activeKey: store.activeSessionKey });
    for (const notification of plan.notifications) host?.notify?.(notification);
    setBanner((current) => {
      if (plan.banner) return plan.banner;
      return current && items.some((item) => item.id === current.id) ? current : null;
    });
  }, [items, store.activeSessionKey]);

  const dismiss = useCallback(() => setBanner(null), []);
  return { banner, dismiss };
}
