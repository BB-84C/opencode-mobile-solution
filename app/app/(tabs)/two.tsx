import { router, useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';

import type { Session } from '@/src/opencode/types';
import { useOpenCodeMobileStore } from '@/src/store/mobile-store';
import { palette } from '@/src/ui/palette';
import { filterAndSortRootSessions, sessionSearchText, sessionUpdatedAt } from '@/src/ux/session-list';
import { encodeSessionRouteKey, sessionKey, sessionRefForSession } from '@/src/ux/session-forest';

export default function SessionsScreen() {
  const {
    activeConnectionId,
    hydrated,
    connections,
    sessions,
    sessionStatuses,
    loading,
    error,
    hostSyncErrors,
    clearActiveConnection,
    refreshActiveHost,
    subscribeToActiveHost,
    unsubscribeFromHost,
  } = useOpenCodeMobileStore(useShallow((state) => ({
    activeConnectionId: state.activeConnectionId,
    hydrated: state.hydrated,
    connections: state.connections,
    sessions: state.sessions,
    sessionStatuses: state.sessionStatuses,
    loading: state.loading,
    error: state.error,
    hostSyncErrors: state.hostSyncErrors,
    clearActiveConnection: state.clearActiveConnection,
    refreshActiveHost: state.refreshActiveHost,
    subscribeToActiveHost: state.subscribeToActiveHost,
    unsubscribeFromHost: state.unsubscribeFromHost,
  })));
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 150);
  const [targetFilter, setTargetFilter] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const transitionLock = useRef(false);
  const active = connections.find((item) => item.id === activeConnectionId);
  const activeHostId = active?.id;
  const activeSessions = activeConnectionId ? sessions[activeConnectionId] ?? [] : [];
  const syncError = activeConnectionId ? hostSyncErrors[activeConnectionId] ?? error : error;
  const statuses = sessionStatuses;
  const rootSessions = useMemo(() => filterAndSortRootSessions(activeSessions), [activeSessions]);
  const machines = useMemo(() => machineChoices(rootSessions), [rootSessions]);
  const visibleSessions = useMemo(
    () => {
      const normalizedQuery = debouncedQuery.trim().toLocaleLowerCase();
      return rootSessions
        .filter((session) => !targetFilter || session.relayTargetID === targetFilter)
        .filter((session) => !normalizedQuery || sessionSearchText(session).includes(normalizedQuery));
    },
    [debouncedQuery, rootSessions, targetFilter],
  );

  useFocusEffect(
    useCallback(() => {
      transitionLock.current = false;
      setOpeningKey(null);
      if (!activeHostId) return;
      void refreshActiveHost();
      subscribeToActiveHost();
      return () => unsubscribeFromHost(activeHostId);
    }, [activeHostId, refreshActiveHost, subscribeToActiveHost, unsubscribeFromHost]),
  );

  useEffect(() => {
    if (hydrated && activeConnectionId && !active) clearActiveConnection();
  }, [active, activeConnectionId, clearActiveConnection, hydrated]);

  const openSession = useCallback((session: Session) => {
    if (!activeConnectionId || transitionLock.current) return;
    const ref = sessionRefForSession(activeConnectionId, session);
    transitionLock.current = true;
    setOpeningKey(sessionKey(ref));
    requestAnimationFrame(() => {
      router.push({
        pathname: '/session/[sessionKey]' as never,
        params: { sessionKey: encodeSessionRouteKey(ref) },
      });
    });
  }, [activeConnectionId]);

  const keyExtractor = useCallback(
    (session: Session) => activeConnectionId ? sessionKey(sessionRefForSession(activeConnectionId, session)) : session.id,
    [activeConnectionId],
  );

  const renderSession = useCallback(({ item }: { item: Session }) => {
    const ref = sessionRefForSession(activeConnectionId ?? 'unselected', item);
    const key = sessionKey(ref);
    const status = statuses[key];
    const busy = isBusy(status);
    const opening = openingKey === key;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${item.title || item.id}`}
        accessibilityState={{ disabled: transitionLock.current }}
        testID={`session-card-${key}`}
        disabled={Boolean(openingKey)}
        style={({ pressed }) => [styles.sessionCard, pressed && !openingKey && styles.sessionCardPressed, opening && styles.sessionCardOpening]}
        onPress={() => openSession(item)}>
        <View style={styles.sessionTop}>
          <Text numberOfLines={2} style={styles.sessionTitle}>{item.title || 'Untitled session'}</Text>
          {opening ? <ActivityIndicator testID={`session-opening-${key}`} size="small" color={palette.primary} /> : (
            <Text style={[styles.status, busy ? styles.busy : styles.idle]}>{busy ? 'RUNNING' : 'IDLE'}</Text>
          )}
        </View>
        <Text numberOfLines={1} style={styles.machine}>{item.relayTargetName ?? item.relayTargetID ?? active?.name}</Text>
        <Text numberOfLines={1} ellipsizeMode="middle" style={styles.muted}>{item.directory ?? item.path ?? 'Unknown directory'}</Text>
        <Text style={styles.updated}>{formatUpdated(sessionUpdatedAt(item))}</Text>
      </Pressable>
    );
  }, [active?.name, activeConnectionId, openSession, openingKey, statuses]);

  if (hydrated && !active) {
    return (
      <View style={styles.emptyScreen}>
        <Text style={styles.title}>No relay selected</Text>
        <Text style={styles.muted}>Choose a relay on the Hosts tab to browse its existing sessions.</Text>
      </View>
    );
  }

  const initialLoading = !hydrated || (loading === 'loading' && activeSessions.length === 0);

  return (
    <SafeAreaView testID="sessions-safe-area" edges={['top', 'left', 'right']} style={styles.safeArea}>
      <FlatList
        testID="sessions-list"
        data={visibleSessions}
        keyExtractor={keyExtractor}
        contentContainerStyle={[styles.content, visibleSessions.length === 0 && styles.contentEmpty]}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        ListHeaderComponent={(
          <View style={styles.headerBlock}>
            <View style={styles.header}>
              <View style={styles.headerCopy}>
                <Text testID="sessions-title" style={styles.title}>Sessions</Text>
                <Text numberOfLines={1} testID="sessions-host-label" style={styles.muted}>
                  {active?.name ?? 'Loading relay'}{active ? ` · ${active.url.replace(/^https?:\/\//, '')}` : ''}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sync sessions"
                testID="sessions-sync-button"
                disabled={!active || loading === 'loading'}
                style={[styles.iconButton, (!active || loading === 'loading') && styles.disabled]}
                onPress={async () => {
                  setActionError(null);
                  try {
                    await refreshActiveHost();
                  } catch (syncError) {
                    setActionError(syncError instanceof Error ? syncError.message : String(syncError));
                  }
                }}>
                {loading === 'loading' ? (
                  <ActivityIndicator size="small" color={palette.primary} />
                ) : (
                  <SymbolView name={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }} tintColor={palette.text} size={18} />
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Settings"
                testID="sessions-settings-button"
                style={styles.iconButton}
                onPress={() => router.push('/modal')}>
                <SymbolView name={{ ios: 'gearshape', android: 'settings', web: 'settings' }} tintColor={palette.text} size={18} />
              </Pressable>
            </View>

            <View style={styles.searchRow}>
              <SymbolView name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }} tintColor={palette.textMuted} size={16} />
              <TextInput
                accessibilityLabel="Search sessions"
                testID="sessions-search-input"
                value={query}
                onChangeText={setQuery}
                onSubmitEditing={Keyboard.dismiss}
                placeholder="Search title, machine, directory, or ID"
                placeholderTextColor={palette.textMuted}
                returnKeyType="search"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.searchInput}
              />
              {query ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Clear search" testID="sessions-search-clear" onPress={() => setQuery('')}>
                  <SymbolView name={{ ios: 'xmark.circle.fill', android: 'cancel', web: 'cancel' }} tintColor={palette.textMuted} size={18} />
                </Pressable>
              ) : null}
            </View>

            {machines.length > 1 ? (
              <View testID="sessions-machine-filters" style={styles.filters}>
                <MachineFilter label="All machines" selected={!targetFilter} onPress={() => setTargetFilter(null)} />
                {machines.map((machine) => (
                  <MachineFilter
                    key={machine.id}
                    label={`${machine.name} · ${machine.count}`}
                    selected={targetFilter === machine.id}
                    onPress={() => setTargetFilter(machine.id)}
                  />
                ))}
              </View>
            ) : null}

            {syncError ? (
              <Text selectable testID="sessions-load-error" style={styles.error}>
                {activeSessions.length > 0 ? `Sync warning · ${syncError}` : syncError}
              </Text>
            ) : null}
            {actionError ? <Text selectable testID="sessions-action-error" style={styles.error}>{actionError}</Text> : null}
            <Text testID="sessions-result-count" style={styles.resultCount}>
              {visibleSessions.length} existing session{visibleSessions.length === 1 ? '' : 's'} · newest activity first
            </Text>
          </View>
        )}
        ListEmptyComponent={initialLoading ? (
          <View testID="sessions-loading" style={styles.centerState}>
            <ActivityIndicator size="small" color={palette.primary} />
            <Text style={styles.muted}>Loading sessions…</Text>
          </View>
        ) : (
          <View testID="sessions-empty" style={styles.centerState}>
            <Text style={styles.sectionTitle}>{query || targetFilter ? 'No matching sessions' : 'No existing sessions'}</Text>
            <Text style={styles.muted}>This app monitors sessions that were started on an OpenCode machine.</Text>
          </View>
        )}
        renderItem={renderSession}
      />
      {openingKey ? (
        <View pointerEvents="auto" testID="session-navigation-blocker" style={styles.navigationBlocker}>
          <ActivityIndicator size="small" color={palette.primary} />
          <Text style={styles.blockerText}>Opening transcript…</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timeout);
  }, [delayMs, value]);
  return debounced;
}

function MachineFilter({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[styles.filterChip, selected && styles.filterChipSelected]}
      onPress={onPress}>
      <Text numberOfLines={1} style={[styles.filterText, selected && styles.filterTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function machineChoices(sessions: Session[]) {
  const choices = new Map<string, { id: string; name: string; count: number }>();
  for (const session of sessions) {
    if (!session.relayTargetID) continue;
    const current = choices.get(session.relayTargetID);
    choices.set(session.relayTargetID, {
      id: session.relayTargetID,
      name: session.relayTargetName ?? session.relayTargetID,
      count: (current?.count ?? 0) + 1,
    });
  }
  return [...choices.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isBusy(status: unknown) {
  if (!status || typeof status !== 'object') return false;
  const record = status as Record<string, unknown>;
  return record.type === 'busy' || record.type === 'retry' || record.running === true;
}

function formatUpdated(timestamp: number) {
  if (!timestamp) return 'Activity time unavailable';
  return `Updated ${new Date(timestamp).toLocaleString()}`;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: 10, paddingBottom: 18, gap: 7 },
  contentEmpty: { flexGrow: 1 },
  headerBlock: { gap: 8, paddingTop: 6, paddingBottom: 4 },
  header: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { fontSize: 21, lineHeight: 25, fontWeight: '800', color: palette.text },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: palette.text },
  muted: { fontSize: 11, lineHeight: 15, color: palette.textMuted },
  iconButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: palette.borderSubtle, borderRadius: 9 },
  disabled: { opacity: 0.45 },
  searchRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, borderWidth: 1, borderColor: palette.borderSubtle, borderRadius: 9, backgroundColor: palette.backgroundElement },
  searchInput: { flex: 1, minWidth: 0, paddingVertical: 7, fontSize: 13, color: palette.text },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  filterChip: { maxWidth: '100%', paddingHorizontal: 9, paddingVertical: 5, borderWidth: 1, borderColor: palette.borderSubtle, borderRadius: 14, backgroundColor: palette.panel },
  filterChipSelected: { borderColor: palette.primary, backgroundColor: palette.primary },
  filterText: { maxWidth: 180, fontSize: 10, fontWeight: '700', color: palette.textMuted },
  filterTextSelected: { color: palette.foregroundOnAccent },
  resultCount: { fontSize: 10, lineHeight: 13, textTransform: 'uppercase', color: palette.textMuted },
  sessionCard: { gap: 3, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: palette.borderSubtle, borderRadius: 8, backgroundColor: palette.panel },
  sessionCardPressed: { borderColor: palette.borderActive, backgroundColor: palette.backgroundElement },
  sessionCardOpening: { borderColor: palette.primary, opacity: 0.72 },
  sessionTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  sessionTitle: { flex: 1, fontSize: 13, lineHeight: 17, fontWeight: '700', color: palette.text },
  machine: { fontSize: 10, lineHeight: 13, fontWeight: '800', color: palette.accent },
  status: { fontSize: 9, lineHeight: 13, fontWeight: '800' },
  busy: { color: palette.success },
  idle: { color: palette.textMuted },
  updated: { fontSize: 9, lineHeight: 12, color: palette.textMuted },
  centerState: { flex: 1, minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 20 },
  emptyScreen: { flex: 1, justifyContent: 'center', gap: 8, padding: 24, backgroundColor: palette.background },
  error: { padding: 8, borderWidth: 1, borderColor: palette.error, borderRadius: 8, color: palette.error },
  navigationBlocker: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 9, backgroundColor: palette.scrim },
  blockerText: { fontSize: 13, fontWeight: '800', color: palette.text },
});
