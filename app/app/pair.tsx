import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { exchangePairingCode } from '@/src/opencode/pairing';
import { useOpenCodeMobileStore } from '@/src/store/mobile-store';
import { palette } from '@/src/ui/palette';

type PairingState = 'connecting' | 'connected' | 'error';

export default function PairRelayScreen() {
  const { origin, code } = useLocalSearchParams<{ origin?: string; code?: string }>();
  const { hydrate, pairConnection, refreshActiveHost } = useOpenCodeMobileStore();
  const started = useRef(false);
  const [pairingState, setPairingState] = useState<PairingState>('connecting');
  const [message, setMessage] = useState('Exchanging one-time pairing code…');

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const run = async () => {
      try {
        if (typeof origin !== 'string' || typeof code !== 'string') throw new Error('Pairing link is incomplete');
        await hydrate();
        const connection = await exchangePairingCode({
          origin,
          code,
          deviceName: Platform.OS === 'ios' ? 'OpenCode iPhone' : 'OpenCode phone',
        });
        await pairConnection(connection);
        setPairingState('connected');
        setMessage(`Connected to ${new URL(connection.url).host}`);
        try {
          await refreshActiveHost();
          router.replace('/two');
        } catch {
          setMessage(`Connected to ${new URL(connection.url).host}. Sync will resume when a machine is online.`);
        }
      } catch (pairingError) {
        setPairingState('error');
        setMessage(pairingError instanceof Error ? pairingError.message : String(pairingError));
      }
    };
    void run();
  }, [code, hydrate, origin, pairConnection, refreshActiveHost]);

  return (
    <SafeAreaView testID="pair-safe-area" style={styles.safeArea}>
      <View style={styles.content}>
        <View style={[styles.mark, pairingState === 'error' && styles.markError]} />
        <Text style={styles.title}>{pairingState === 'error' ? 'Pairing failed' : pairingState === 'connected' ? 'Phone connected' : 'Connecting…'}</Text>
        <Text selectable testID="pair-status-message" style={styles.message}>{message}</Text>
        {pairingState !== 'connecting' ? (
          <Pressable
            accessibilityRole="button"
            testID="pair-continue-button"
            style={styles.button}
            onPress={() => router.replace(pairingState === 'connected' ? '/two' : '/')}>
            <Text style={styles.buttonText}>{pairingState === 'connected' ? 'Open sessions' : 'Back to hosts'}</Text>
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.background,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    padding: 28,
  },
  mark: {
    width: 70,
    height: 70,
    borderWidth: 11,
    borderColor: palette.primary,
    borderRightColor: palette.accent,
    borderRadius: 22,
  },
  markError: {
    borderColor: palette.error,
    borderRightColor: palette.error,
  },
  title: {
    color: palette.text,
    fontSize: 22,
    fontWeight: '800',
  },
  message: {
    color: palette.textMuted,
    lineHeight: 20,
    textAlign: 'center',
  },
  button: {
    minWidth: 180,
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: palette.primary,
  },
  buttonText: {
    color: palette.foregroundOnAccent,
    fontWeight: '800',
  },
});
