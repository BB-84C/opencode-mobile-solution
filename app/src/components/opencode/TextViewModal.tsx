import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { palette } from '@/src/ui/palette';
import { writeClipboardText } from '@/src/ux/clipboard';

export function TextViewModal({
  title,
  text,
  visible,
  wordWrap = true,
  onClose,
}: {
  title: string;
  text: string;
  visible: boolean;
  wordWrap?: boolean;
  onClose(): void;
}) {
  const [copyError, setCopyError] = useState<string | null>(null);
  return (
    <Modal
      animationType="slide"
      transparent
      presentationStyle="overFullScreen"
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
      visible={visible}
      onRequestClose={onClose}>
      <Pressable testID="text-view-scrim" style={styles.scrim} onPress={onClose}>
        <Pressable testID="text-view-sheet" style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable
              accessibilityRole="button"
              testID="text-view-copy-raw"
              style={styles.copyButton}
              onPress={async () => {
                setCopyError(null);
                try {
                  await writeClipboardText(text);
                } catch (error) {
                  setCopyError(error instanceof Error ? error.message : String(error));
                }
              }}>
              <Text style={styles.copyButtonText}>Copy raw</Text>
            </Pressable>
          </View>
          {copyError ? <Text selectable testID="text-view-copy-error" style={styles.error}>{copyError}</Text> : null}
          <ScrollView testID="text-view-scroll" style={styles.textFrame} contentContainerStyle={styles.textContent}>
            <Text selectable testID="text-view-content" style={[styles.mono, wordWrap && styles.wordWrap]}>
              {text || 'No text content'}
            </Text>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: palette.scrim,
  },
  sheet: {
    maxHeight: '86%',
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 30,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    backgroundColor: palette.panel,
  },
  handle: {
    alignSelf: 'center',
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.borderActive,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: palette.text,
  },
  copyButton: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: palette.primary,
  },
  copyButtonText: {
    fontWeight: '800',
    color: palette.foregroundOnAccent,
  },
  error: {
    color: palette.error,
  },
  textFrame: {
    flexShrink: 1,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    borderRadius: 8,
    backgroundColor: palette.codeBg,
  },
  textContent: {
    padding: 12,
  },
  mono: {
    fontFamily: 'SpaceMono',
    fontSize: 12,
    lineHeight: 18,
    color: palette.code,
  },
  wordWrap: {
    flexShrink: 1,
    flexWrap: 'wrap',
  },
});
