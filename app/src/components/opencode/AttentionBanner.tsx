import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { palette } from '@/src/ui/palette';
import { attentionNotification, attentionRoute, type AttentionItem } from '@/src/ux/attention';

export function AttentionBanner({ item, onDismiss }: { item: AttentionItem | null; onDismiss(): void }) {
  const insets = useSafeAreaInsets();
  if (!item) return null;
  const { title, body } = attentionNotification(item);
  return (
    <View pointerEvents="box-none" style={[styles.frame, { top: insets.top + 6 }]}>
      <Pressable
        accessibilityRole="button"
        testID={`attention-banner-${item.id}`}
        style={[styles.banner, item.kind === 'error' && styles.errorBanner]}
        onPress={() => {
          onDismiss();
          router.push(attentionRoute(item) as never);
        }}>
        <View style={styles.copy}>
          <Text style={[styles.title, item.kind === 'error' && styles.errorTitle]}>{title}</Text>
          <Text numberOfLines={2} style={styles.body}>{body}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" testID="attention-banner-dismiss" hitSlop={10} onPress={onDismiss}>
          <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} tintColor={palette.textMuted} size={14} />
        </Pressable>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { position: 'absolute', left: 10, right: 10, alignItems: 'center' },
  banner: {
    width: '100%',
    maxWidth: 560,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: palette.warning,
    backgroundColor: palette.backgroundMenu,
  },
  errorBanner: { borderColor: palette.error },
  errorTitle: { color: palette.error },
  copy: { flex: 1, gap: 2 },
  title: { fontSize: 12, fontWeight: '800', color: palette.warning },
  body: { fontSize: 12, color: palette.text },
});
