import { router } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { palette } from '@/src/ui/palette';

export function SettingsDoneButton() {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Close settings"
      testID="settings-close"
      hitSlop={10}
      style={styles.doneButton}
      onPress={() => router.back()}>
      <Text style={styles.doneText}>Done</Text>
    </Pressable>
  );
}

export const settingsModalOptions = {
  headerShown: true,
  presentation: 'fullScreenModal' as const,
  title: 'Settings',
  headerStyle: { backgroundColor: palette.backgroundPanel },
  headerTintColor: palette.text,
  headerShadowVisible: true,
  headerRight: () => <SettingsDoneButton />,
};

const styles = StyleSheet.create({
  doneButton: {
    minWidth: 52,
    minHeight: 40,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  doneText: {
    fontWeight: '800',
    color: palette.primary,
  },
});
