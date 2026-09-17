import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useOpenCodeMobileStore } from '@/src/store/mobile-store';
import { palette } from '@/src/ui/palette';

export default function SettingsScreen() {
  const {
    activeConnectionId,
    connections,
    loading,
    error,
    hydrate,
    refreshActiveHost,
    clearActiveConnection,
    activeSessionRef,
    sessions,
    deleteSession,
  } = useOpenCodeMobileStore();
  const activeHost = connections.find((connection) => connection.id === activeConnectionId);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const openSession = activeSessionRef
    ? (sessions[activeSessionRef.connectionId] ?? []).find((item) => item.id === activeSessionRef.sessionId)
    : undefined;

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <SafeAreaView testID="settings-safe-area" edges={['bottom', 'left', 'right']} style={styles.safeArea}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.sectionTitle}>Connection</Text>
        <View style={styles.infoCard}>
          <Text style={styles.cardLabel}>{activeHost?.name ?? 'No active host'}</Text>
          <Text selectable style={styles.cardDetail}>{activeHost?.url ?? 'Choose a relay from Hosts'}</Text>
          <Text style={[styles.cardDetail, activeHost?.isReachable ? styles.connected : styles.muted]}>
            {activeHost?.isReachable ? 'Connected' : activeHost ? 'Not checked' : 'Disconnected'}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          testID="settings-manage-hosts"
          style={styles.rowButton}
          onPress={() => router.replace('/')}>
          <Text style={styles.rowLabel}>Manage hosts</Text>
          <Text style={styles.rowDetail}>Add or select relay connections</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          testID="settings-sync-host"
          disabled={!activeHost || loading === 'loading'}
          style={[styles.rowButton, (!activeHost || loading === 'loading') && styles.disabled]}
          onPress={async () => {
            setActionError(null);
            try {
              await refreshActiveHost();
            } catch (syncError) {
              setActionError(syncError instanceof Error ? syncError.message : String(syncError));
            }
          }}>
          <Text style={styles.rowLabel}>{loading === 'loading' ? 'Syncing active host…' : 'Sync active host'}</Text>
          <Text style={styles.rowDetail}>Refresh machines, workspaces, sessions, agents, and commands</Text>
        </Pressable>
        {activeHost ? (
          <Pressable
            accessibilityRole="button"
            testID="settings-clear-active-host"
            style={styles.rowButton}
            onPress={() => {
              clearActiveConnection();
              router.replace('/');
            }}>
            <Text style={styles.dangerText}>Disconnect active host</Text>
            <Text style={styles.rowDetail}>Return to Hosts without deleting saved credentials</Text>
          </Pressable>
        ) : null}

        <Text style={styles.sectionTitle}>Session</Text>
        {openSession ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={confirmingDelete ? 'Confirm deleting this session' : 'Delete this session'}
            testID={confirmingDelete ? 'settings-delete-session-confirm' : 'settings-delete-session'}
            disabled={deleting}
            style={[styles.rowButton, deleting && styles.disabledRow]}
            onPress={async () => {
              setActionError(null);
              if (!confirmingDelete) {
                setConfirmingDelete(true);
                return;
              }
              setDeleting(true);
              try {
                await deleteSession(activeSessionRef!);
                setConfirmingDelete(false);
                router.replace('/(tabs)/two');
              } catch (deleteError) {
                setActionError(deleteError instanceof Error ? deleteError.message : String(deleteError));
              } finally {
                setDeleting(false);
              }
            }}>
            <Text style={styles.dangerText}>
              {deleting ? 'Deleting…' : confirmingDelete ? 'Tap again to delete permanently' : 'Delete this session'}
            </Text>
            <Text style={styles.rowDetail} numberOfLines={2}>
              {confirmingDelete
                ? `"${openSession.title ?? openSession.id}" will be removed on the machine that owns it`
                : `"${openSession.title ?? openSession.id}" · removes it for every device, not just this one`}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.infoCard}>
            <Text style={styles.cardLabel}>No session is open</Text>
            <Text style={styles.cardDetail}>Open a session to be able to delete it from here</Text>
          </View>
        )}
        {confirmingDelete && !deleting ? (
          <Pressable
            accessibilityRole="button"
            testID="settings-delete-session-cancel"
            style={styles.rowButton}
            onPress={() => setConfirmingDelete(false)}>
            <Text style={styles.rowLabel}>Cancel</Text>
            <Text style={styles.rowDetail}>Keep this session</Text>
          </Pressable>
        ) : null}

        <Text style={styles.sectionTitle}>Appearance</Text>
        <View style={styles.infoCard}>
          <Text style={styles.cardLabel}>OpenCode dark</Text>
          <Text style={styles.cardDetail}>Official OpenCode TUI theme</Text>
        </View>

        <Text style={styles.sectionTitle}>About</Text>
        <View style={styles.infoCard}>
          <Text style={styles.cardLabel}>OpenCode Mobile</Text>
          <Text style={styles.cardDetail}>Version 1.0.0 · remote session cockpit</Text>
        </View>
        {error ? <Text selectable testID="settings-error" style={styles.error}>{error}</Text> : null}
        {actionError ? <Text selectable testID="settings-action-error" style={styles.error}>{actionError}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  screen: { flex: 1, backgroundColor: palette.background },
  content: { gap: 8, padding: 12, paddingBottom: 24 },
  disabledRow: { opacity: 0.5 },
  sectionTitle: { marginTop: 6, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', color: palette.textMuted },
  infoCard: { gap: 3, padding: 11, borderWidth: 1, borderColor: palette.borderSubtle, backgroundColor: palette.panel },
  cardLabel: { fontSize: 15, fontWeight: '700', color: palette.text },
  cardDetail: { fontSize: 12, lineHeight: 17, color: palette.textMuted },
  connected: { color: palette.success },
  muted: { color: palette.textMuted },
  rowButton: { minHeight: 52, justifyContent: 'center', gap: 3, padding: 11, borderWidth: 1, borderColor: palette.borderSubtle },
  rowLabel: { fontSize: 15, fontWeight: '700', color: palette.text },
  rowDetail: { fontSize: 12, lineHeight: 17, color: palette.textMuted },
  dangerText: { fontSize: 15, fontWeight: '700', color: palette.error },
  disabled: { opacity: 0.45 },
  error: { padding: 10, color: palette.error },
});
