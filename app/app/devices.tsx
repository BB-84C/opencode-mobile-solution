import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useOpenCodeMobileStore } from '@/src/store/mobile-store';
import { palette } from '@/src/ui/palette';
import {
  buildDeviceSelectionModel,
  isDeviceChoiceSelectable,
  soleSelectableChoice,
  type DeviceChoice,
} from '@/src/ux/device-selection';

export default function DevicesScreen() {
  const store = useOpenCodeMobileStore();
  const model = useMemo(
    () => buildDeviceSelectionModel({
      connections: store.connections,
      relayTargets: store.relayTargets,
      syncErrors: store.hostSyncErrors,
    }),
    [store.connections, store.relayTargets, store.hostSyncErrors],
  );

  // This screen only reads the machine list; something has to go and ask for it.
  // On a cold start nothing has, so without this the first screen reports "no
  // machine authorized" for a relay that is perfectly willing to answer.
  const asked = useRef(new Set<string>());
  const [discovering, setDiscovering] = useState(false);
  useEffect(() => {
    const connections = store.connections;
    if (connections.length === 0) return;
    const activeId = store.activeConnectionId ?? connections[0].id;
    if (!store.activeConnectionId) store.setActiveConnection(activeId);
    if ((store.relayTargets[activeId] ?? []).length > 0) return;
    if (asked.current.has(activeId)) return;
    asked.current.add(activeId);
    setDiscovering(true);
    void store.refreshActiveHost().finally(() => setDiscovering(false));
  }, [store.connections, store.relayTargets, store.activeConnectionId]);

  const open = (choice: DeviceChoice) => {
    if (!isDeviceChoiceSelectable(choice)) return;
    store.setActiveConnection(choice.hostId);
    router.push({ pathname: '/two', params: { machine: choice.targetId } });
  };

  // With one machine there is no choice to present, and stopping to ask for it
  // would be a screen the user has to dismiss every launch.
  const sole = soleSelectableChoice(model);
  useEffect(() => {
    if (sole) open(sole);
  }, [sole?.hostId, sole?.targetId]);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Choose a machine</Text>
        {model.totalChoices > 0 ? (
          <Text style={styles.subtitle}>
            {`${model.reachableChoices} of ${model.totalChoices} reachable`}
          </Text>
        ) : discovering ? (
          <Text testID="devices-discovering" style={styles.subtitle}>Asking the relay which machines it has…</Text>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {model.emptyReason && model.groups.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{model.emptyReason}</Text>
            <Pressable style={styles.link} onPress={() => router.push('/')}>
              <Text style={styles.linkText}>Pair a host</Text>
            </Pressable>
          </View>
        ) : null}

        {model.groups.map((group) => (
          <View key={group.hostId} style={styles.group}>
            <View style={styles.groupHead}>
              <Text style={styles.host}>{group.hostName}</Text>
              <Text style={[styles.badge, group.hostReachable ? styles.badgeUp : styles.badgeDown]}>
                {group.hostReachable ? 'online' : 'offline'}
              </Text>
            </View>

            {group.sharesSessionsAcrossMachines ? (
              <Text style={styles.note}>
                These machines share one session database, so every session appears under each of
                them. Choosing one picks which process runs your next prompt.
              </Text>
            ) : null}

            {group.choices.map((choice) => {
              const selectable = isDeviceChoiceSelectable(choice);
              return (
                <Pressable
                  key={`${choice.hostId}:${choice.targetId || 'none'}`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !selectable }}
                  disabled={!selectable}
                  onPress={() => open(choice)}
                  style={[styles.choice, !selectable && styles.choiceBlocked]}>
                  <View style={styles.choiceMain}>
                    <Text style={styles.machine}>{choice.targetName}</Text>
                    {choice.blockedReason ? (
                      <Text style={styles.reason}>{choice.blockedReason}</Text>
                    ) : null}
                  </View>
                  <Text style={selectable ? styles.openHint : styles.reason}>
                    {selectable ? 'Open' : 'Unavailable'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Manage hosts"
          testID="devices-manage-hosts"
          style={styles.manage}
          onPress={() => router.push('/(tabs)')}>
          <Text style={styles.manageText}>Manage hosts</Text>
          <Text style={styles.note}>Add a relay, edit its address or token, or remove one</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  header: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 10, gap: 4 },
  title: { fontSize: 22, fontWeight: '800', color: palette.text },
  subtitle: { fontSize: 13, color: palette.textMuted },
  list: { padding: 14, gap: 14 },
  group: { borderRadius: 14, borderWidth: 1, borderColor: palette.borderSubtle, backgroundColor: palette.backgroundPanel, padding: 12, gap: 10 },
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  host: { fontSize: 15, fontWeight: '700', color: palette.text },
  badge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 9, overflow: 'hidden' },
  badgeUp: { color: palette.background, backgroundColor: palette.success },
  badgeDown: { color: palette.background, backgroundColor: palette.textMuted },
  manage: { borderRadius: 14, borderWidth: 1, borderColor: palette.borderSubtle, backgroundColor: palette.backgroundPanel, padding: 14, gap: 4 },
  manageText: { fontSize: 15, fontWeight: '700', color: palette.primary },
  note: { fontSize: 12, lineHeight: 17, color: palette.textMuted },
  choice: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 11, backgroundColor: palette.backgroundElement },
  choiceBlocked: { opacity: 0.55 },
  choiceMain: { flex: 1, gap: 2 },
  machine: { fontSize: 14, fontWeight: '700', color: palette.text },
  reason: { fontSize: 11, color: palette.textMuted },
  openHint: { fontSize: 12, fontWeight: '800', color: palette.primary },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 30 },
  emptyText: { fontSize: 13, color: palette.textMuted },
  link: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, backgroundColor: palette.primary },
  linkText: { fontSize: 13, fontWeight: '800', color: palette.foregroundOnAccent },
});
