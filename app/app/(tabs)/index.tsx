import { router } from 'expo-router';
import { Camera, CameraView } from 'expo-camera';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useOpenCodeMobileStore } from '@/src/store/mobile-store';
import { palette } from '@/src/ui/palette';
import { routeForSelectedHost } from '@/src/ux/host-selection';
import { parseRelayPairingQr } from '@/src/opencode/pairing-qr';
import type { AuthType } from '@/src/opencode/types';

export default function HostsScreen() {
  const {
    connections,
    activeConnectionId,
    loading,
    error,
    hydrate,
    addConnection,
    updateConnection,
    removeConnection,
    setActiveConnection,
    clearActiveConnection,
    refreshActiveHost,
  } = useOpenCodeMobileStore();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<AuthType>('bearer');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [addingHost, setAddingHost] = useState(false);
  const [advancedSetup, setAdvancedSetup] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const acceptingQrScan = useRef(false);
  const urlError = validateRelayUrl(url);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const subscription = CameraView.onModernBarcodeScanned(({ data }) => {
      if (!acceptingQrScan.current) return;
      try {
        const pairing = parseRelayPairingQr(data);
        acceptingQrScan.current = false;
        setActionError(null);
        void CameraView.dismissScanner()
          .catch(() => undefined)
          .then(() => router.push({
            pathname: '/pair',
            params: { origin: pairing.origin, code: pairing.code },
          }));
      } catch (scanError) {
        setActionError(scanError instanceof Error ? scanError.message : String(scanError));
      }
    });
    return () => subscription.remove();
  }, []);

  async function openQrScanner() {
    setActionError(null);
    try {
      if (!CameraView.isModernBarcodeScannerAvailable) {
        throw new Error('QR scanning is unavailable on this device');
      }
      const permission = await Camera.requestCameraPermissionsAsync();
      if (!permission.granted) {
        throw new Error('Camera access is required to scan a relay pairing QR code');
      }
      acceptingQrScan.current = true;
      await CameraView.launchScanner({
        barcodeTypes: ['qr'],
        isGuidanceEnabled: true,
        isHighlightingEnabled: true,
      });
    } catch (scanError) {
      acceptingQrScan.current = false;
      const message = scanError instanceof Error ? scanError.message : String(scanError);
      setActionError(/scanner.*(not available|unavailable)|not available.*scanner/i.test(message)
        ? 'QR scanning requires a camera-enabled iPhone'
        : message);
    }
  }

  const canAdd =
    url.trim().length > 0 &&
    !urlError &&
    !addingHost &&
    (authType === 'bearer' ? token.trim().length > 0 : username.trim().length > 0 && password.length > 0);

  function resetForm() {
    setEditingConnectionId(null);
    setName('');
    setUrl('');
    setToken('');
    setUsername('');
    setPassword('');
    setAdvancedSetup(false);
  }

  return (
    <SafeAreaView testID="hosts-safe-area" edges={['top', 'left', 'right']} style={styles.safeArea}>
    <ScrollView
      testID="hosts-scroll"
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={styles.headerTitle}>
          <Text style={styles.title}>OpenCode</Text>
          <Text style={styles.subtitle}>Remote cockpit for agent sessions</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          testID="hosts-settings-button"
          style={styles.settingsButton}
          onPress={() => router.push('/modal')}>
          <SymbolView
            name={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
            tintColor={palette.text}
            size={18}
          />
        </Pressable>
      </View>

      {connections.map((connection) => (
        <View key={connection.id} style={[styles.hostCard, connection.id === activeConnectionId && styles.hostCardActive]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${connection.name}`}
            testID={`host-card-${connection.id}`}
            style={styles.hostSelectButton}
            onPress={() => {
              if (setActiveConnection(connection.id)) {
                const route = routeForSelectedHost(connection.id);
                if (route) router.push(route);
              }
            }}>
            <View style={styles.hostTop}>
              <Text numberOfLines={2} testID={`host-name-${connection.id}`} style={styles.hostName}>{connection.name}</Text>
              <Text testID={`host-status-${connection.id}`} style={[styles.status, connection.isReachable ? styles.green : styles.muted]}>
                {connection.isReachable ? 'connected' : 'idle'}
              </Text>
            </View>
            <Text style={styles.url}>{connection.url}</Text>
            <Text style={styles.muted}>
              {connection.lastConnected ? `Last checked ${new Date(connection.lastConnected).toLocaleString()}` : 'Not checked'}
            </Text>
          </Pressable>
          <View style={styles.hostActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={pendingDeleteId === connection.id ? `Cancel delete ${connection.name}` : `Edit ${connection.name}`}
              testID={`edit-host-${connection.id}`}
              style={styles.hostActionButton}
              onPress={() => {
                if (pendingDeleteId === connection.id) {
                  setPendingDeleteId(null);
                  return;
                }
                setEditingConnectionId(connection.id);
                setPendingDeleteId(null);
                setName(connection.name);
                setUrl(connection.url);
                setAuthType(connection.authType);
                setToken(connection.token ?? '');
                setUsername(connection.username ?? '');
                setPassword(connection.password ?? '');
              }}>
              <Text style={styles.hostActionText}>{pendingDeleteId === connection.id ? 'Cancel' : 'Edit'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={pendingDeleteId === connection.id ? `Confirm delete ${connection.name}` : `Delete ${connection.name}`}
              testID={`delete-host-${connection.id}`}
              style={[styles.hostActionButton, pendingDeleteId === connection.id && styles.deleteConfirmButton]}
              onPress={async () => {
                if (pendingDeleteId !== connection.id) {
                  setPendingDeleteId(connection.id);
                  return;
                }
                setActionError(null);
                try {
                  await removeConnection(connection.id);
                  setPendingDeleteId(null);
                  if (editingConnectionId === connection.id) resetForm();
                } catch (deleteError) {
                  setActionError(deleteError instanceof Error ? deleteError.message : String(deleteError));
                }
              }}>
              <Text style={[styles.hostActionText, pendingDeleteId === connection.id && styles.deleteConfirmText]}>
                {pendingDeleteId === connection.id ? 'Confirm delete' : 'Delete'}
              </Text>
            </Pressable>
          </View>
        </View>
      ))}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Scan relay pairing QR code"
        accessibilityHint="Opens the camera scanner"
        testID="qr-pairing-guide"
        style={({ pressed }) => [styles.pairingCard, pressed && styles.pairingCardPressed]}
        onPress={openQrScanner}>
        <View style={styles.pairingMark} />
        <View style={styles.pairingCopy}>
          <Text style={styles.sectionTitle}>Connect with QR</Text>
          <Text style={styles.muted}>
            Open your relay Dashboard on another device, tap Connect phone, then scan its QR.
          </Text>
        </View>
        <Text style={styles.pairingAction}>Scan</Text>
      </Pressable>

      {!advancedSetup && !editingConnectionId ? (
        <Pressable
          accessibilityRole="button"
          testID="advanced-manual-setup-button"
          style={styles.secondaryButton}
          onPress={() => setAdvancedSetup(true)}>
          <Text style={styles.secondaryText}>Advanced manual setup</Text>
        </Pressable>
      ) : null}

      {advancedSetup || editingConnectionId ? <View style={styles.form}>
        <View style={styles.formHeader}>
          <Text style={styles.sectionTitle}>{editingConnectionId ? 'Edit Host' : 'Add Host'}</Text>
          {editingConnectionId || advancedSetup ? (
            <Pressable accessibilityRole="button" testID="cancel-edit-host" onPress={resetForm}>
              <Text style={styles.hostActionText}>Cancel</Text>
            </Pressable>
          ) : null}
        </View>
        <TextInput
          value={name}
          onChangeText={setName}
          accessibilityLabel="Host name"
          testID="host-name-input"
          placeholder="Name"
          style={styles.input}
          autoCapitalize="words"
        />
        <TextInput
          value={url}
          onChangeText={setUrl}
          accessibilityLabel="Relay URL"
          testID="host-url-input"
          placeholder="https://your-opencode-relay.example"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        {urlError ? <Text testID="host-url-error" style={styles.error}>{urlError}</Text> : null}
        <View style={styles.segmentedControl}>
          {(['bearer', 'basic'] as const).map((mode) => (
            <Pressable
              key={mode}
              accessibilityRole="button"
              testID={`auth-mode-${mode}`}
              style={[styles.segmentButton, authType === mode && styles.segmentButtonActive]}
              onPress={() => setAuthType(mode)}>
              <Text style={[styles.segmentText, authType === mode && styles.segmentTextActive]}>
                {mode === 'bearer' ? 'Bearer' : 'Basic'}
              </Text>
            </Pressable>
          ))}
        </View>
        {authType === 'bearer' ? (
          <TextInput
            value={token}
            onChangeText={setToken}
            accessibilityLabel="Bearer token"
            testID="host-token-input"
            placeholder="Bearer token"
            style={styles.input}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        ) : (
          <>
            <TextInput
              value={username}
              onChangeText={setUsername}
              accessibilityLabel="Basic username"
              testID="host-username-input"
              placeholder="Basic username"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextInput
              value={password}
              onChangeText={setPassword}
              accessibilityLabel="Basic password"
              testID="host-password-input"
              placeholder="Basic password"
              style={styles.input}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </>
        )}
        <Pressable
          accessibilityRole="button"
          testID="add-host-button"
          disabled={!canAdd}
          style={[styles.primaryButton, !canAdd && styles.disabled]}
          onPress={async () => {
            setActionError(null);
            setAddingHost(true);
            try {
              const input = {
                name: name.trim() || new URL(url.trim()).host,
                url: url.trim(),
                authType,
                ...(authType === 'bearer'
                  ? { token: token.trim() }
                  : { username: username.trim(), password }),
              } as const;
              if (editingConnectionId) await updateConnection(editingConnectionId, input);
              else await addConnection(input);
              resetForm();
            } catch (addError) {
              setActionError(addError instanceof Error ? addError.message : String(addError));
            } finally {
              setAddingHost(false);
            }
          }}>
          <Text style={styles.primaryText}>{addingHost ? 'Saving…' : editingConnectionId ? 'Save Host' : 'Add Host'}</Text>
        </Pressable>
      </View> : null}

      <Pressable
        accessibilityRole="button"
        testID="check-active-host-button"
        disabled={!activeConnectionId || loading === 'loading'}
        style={[styles.secondaryButton, (!activeConnectionId || loading === 'loading') && styles.disabled]}
        onPress={async () => {
          setActionError(null);
          try {
            await refreshActiveHost();
          } catch (checkError) {
            setActionError(checkError instanceof Error ? checkError.message : String(checkError));
          }
        }}>
        <Text style={styles.secondaryText}>
          {loading === 'loading' ? 'Checking...' : activeConnectionId ? 'Check Active Host' : 'Select a host to check'}
        </Text>
      </Pressable>
      {activeConnectionId ? (
        <Pressable
          accessibilityRole="button"
          testID="clear-active-host-button"
          style={styles.secondaryButton}
          onPress={clearActiveConnection}>
          <Text style={styles.secondaryText}>Clear Active Host</Text>
        </Pressable>
      ) : null}
      {error ? <Text selectable testID="hosts-error" style={styles.error}>{error}</Text> : null}
      {actionError ? <Text selectable testID="hosts-action-error" style={styles.error}>{actionError}</Text> : null}
      {advancedSetup || editingConnectionId ? (
        <Pressable accessibilityRole="button" testID="hosts-dismiss-keyboard" style={styles.keyboardDismiss} onPress={Keyboard.dismiss}>
          <Text style={styles.muted}>Hide keyboard</Text>
        </Pressable>
      ) : null}
    </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.background,
  },
  screen: {
    flex: 1,
    backgroundColor: palette.background,
  },
  content: {
    gap: 10,
    padding: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  headerTitle: {
    flex: 1,
    gap: 4,
  },
  settingsButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: palette.text,
  },
  subtitle: {
    fontSize: 12,
    color: palette.textMuted,
  },
  hostCard: {
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    borderRadius: 8,
    backgroundColor: palette.panel,
  },
  hostSelectButton: {
    gap: 4,
    padding: 10,
  },
  hostActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.borderSubtle,
  },
  hostActionButton: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  hostActionText: {
    fontSize: 12,
    fontWeight: '700',
    color: palette.primary,
  },
  deleteConfirmButton: {
    backgroundColor: palette.error,
  },
  deleteConfirmText: {
    color: palette.foregroundOnAccent,
  },
  hostCardActive: {
    borderColor: palette.primary,
  },
  hostTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  hostName: {
    flex: 1,
    fontSize: 15,
    lineHeight: 19,
    fontWeight: '700',
    color: palette.text,
  },
  status: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'right',
    textTransform: 'uppercase',
  },
  url: {
    fontSize: 13,
    color: palette.text,
  },
  muted: {
    fontSize: 12,
    color: palette.textMuted,
  },
  green: {
    color: palette.green,
  },
  form: {
    gap: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    borderRadius: 8,
    backgroundColor: palette.panel,
  },
  pairingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    borderRadius: 8,
    backgroundColor: palette.panel,
  },
  pairingCardPressed: {
    opacity: 0.72,
    borderColor: palette.primary,
  },
  pairingMark: {
    width: 38,
    height: 38,
    borderWidth: 6,
    borderColor: palette.primary,
    borderRightColor: palette.accent,
    borderRadius: 12,
  },
  pairingCopy: {
    flex: 1,
    gap: 3,
  },
  pairingAction: {
    flexShrink: 0,
    fontSize: 13,
    fontWeight: '800',
    color: palette.primary,
  },
  formHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: palette.text,
  },
  input: {
    minHeight: 40,
    paddingHorizontal: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: palette.borderActive,
    borderRadius: 8,
    backgroundColor: palette.backgroundElement,
    color: palette.text,
  },
  segmentedControl: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    borderRadius: 8,
    overflow: 'hidden',
  },
  segmentButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    backgroundColor: palette.backgroundElement,
  },
  segmentButtonActive: {
    backgroundColor: palette.primary,
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '700',
    color: palette.textMuted,
  },
  segmentTextActive: {
    color: palette.foregroundOnAccent,
  },
  primaryButton: {
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
    backgroundColor: palette.primary,
  },
  disabled: {
    opacity: 0.45,
  },
  primaryText: {
    fontSize: 14,
    fontWeight: '700',
    color: palette.foregroundOnAccent,
  },
  secondaryButton: {
    alignItems: 'center',
    padding: 10,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    borderRadius: 8,
  },
  secondaryText: {
    fontSize: 14,
    fontWeight: '700',
    color: palette.primary,
  },
  keyboardDismiss: {
    alignSelf: 'center',
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  error: {
    color: palette.red,
  },
});

function validateRelayUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'Use an http:// or https:// relay URL';
    if (!parsed.hostname) return 'Enter a valid relay URL';
    return null;
  } catch {
    return 'Enter a valid http:// or https:// relay URL';
  }
}
