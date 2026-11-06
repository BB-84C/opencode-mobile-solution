import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { palette } from '@/src/ui/palette';
import type { TurnError } from '@/src/ux/turn-error';

import { SelectableText } from './SelectableText';

/**
 * Why a turn stopped, in the red box the TUI uses. The message is selectable so
 * the exact error can be copied into a report.
 */
export function TurnErrorBox({
  error,
  testID,
  onDismiss,
  maxHeight,
}: {
  error: TurnError;
  testID?: string;
  onDismiss?: () => void;
  /** Above the prompt a long error must not push the transcript off screen; it scrolls instead. */
  maxHeight?: number;
}) {
  if (error.aborted) {
    return <Text testID={testID} style={styles.interrupted}>Interrupted</Text>;
  }
  return (
    <View testID={testID} accessibilityRole="alert" style={styles.box}>
      <View style={styles.header}>
        <Text style={styles.title}>{error.title}</Text>
        {onDismiss ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss error" testID={testID ? `${testID}-dismiss` : undefined} hitSlop={10} onPress={onDismiss}>
            <Text style={styles.dismiss}>✕</Text>
          </Pressable>
        ) : null}
      </View>
      {maxHeight ? (
        <ScrollView style={{ maxHeight }}>
          <SelectableText style={styles.message}>{error.message}</SelectableText>
        </ScrollView>
      ) : (
        <SelectableText style={styles.message}>{error.message}</SelectableText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderLeftWidth: 3,
    borderWidth: 1,
    borderRadius: 6,
    borderColor: palette.error,
    backgroundColor: palette.errorBg,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { flexShrink: 1, fontSize: 12, fontWeight: '800', color: palette.error },
  dismiss: { fontSize: 13, color: palette.textMuted },
  message: { fontSize: 13, lineHeight: 18, color: palette.text },
  interrupted: { fontSize: 12, color: palette.textMuted },
});
