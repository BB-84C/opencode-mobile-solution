import { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { useOpenCodeMobileStore } from '@/src/store/mobile-store';
import { palette } from '@/src/ui/palette';

const DISMISS_AFTER_MS = 4_000;

/**
 * Where a keyboard action says what it did, or why it could not.
 *
 * This used to be written into the host sync error, which put it behind a "Sync
 * warning" label on one screen and made it invisible on every other, so a key
 * that reported a problem looked like a key that did nothing.
 */
export function NoticeToast() {
  const notice = useOpenCodeMobileStore((state) => state.notice);
  const dismiss = useOpenCodeMobileStore((state) => state.dismissNotice);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(dismiss, DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);

  if (!notice) return null;

  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Dismiss notice" testID="notice-toast" style={styles.toast} onPress={dismiss}>
      <Text style={styles.text}>{notice}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    backgroundColor: palette.backgroundPanel,
  },
  text: { fontSize: 13, color: palette.text },
});
