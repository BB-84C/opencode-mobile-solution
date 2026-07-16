import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { palette } from '@/src/ui/palette';

export function PromptPasteModal({
  visible,
  value,
  onChangeText,
  onInsert,
  onClose,
}: {
  visible: boolean;
  value: string;
  onChangeText(value: string): void;
  onInsert(): void;
  onClose(): void;
}) {
  return (
    <Modal
      animationType="slide"
      transparent
      presentationStyle="overFullScreen"
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
      visible={visible}
      onRequestClose={onClose}>
      <Pressable testID="manual-paste-scrim" style={styles.scrim} onPress={onClose}>
        <Pressable testID="manual-paste-sheet" style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.handle} />
          <Text style={styles.title}>Paste text</Text>
          <TextInput
            value={value}
            onChangeText={onChangeText}
            multiline
            autoFocus
            testID="manual-paste-input"
            placeholder="Paste text here"
            style={styles.input}
          />
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" testID="manual-paste-cancel" style={styles.secondaryButton} onPress={onClose}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              testID="manual-paste-insert"
              disabled={!value.trim()}
              style={[styles.primaryButton, !value.trim() && styles.disabledButton]}
              onPress={onInsert}>
              <Text style={styles.primaryText}>Insert</Text>
            </Pressable>
          </View>
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
  title: {
    paddingVertical: 6,
    fontSize: 18,
    fontWeight: '700',
    color: palette.text,
  },
  input: {
    minHeight: 120,
    padding: 12,
    borderWidth: 1,
    borderColor: palette.borderActive,
    borderRadius: 8,
    color: palette.text,
    backgroundColor: palette.backgroundElement,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  primaryButton: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: palette.primary,
  },
  secondaryButton: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    borderRadius: 8,
    backgroundColor: palette.backgroundElement,
  },
  disabledButton: {
    opacity: 0.5,
  },
  primaryText: {
    fontWeight: '800',
    color: palette.foregroundOnAccent,
  },
  secondaryText: {
    fontWeight: '800',
    color: palette.text,
  },
});
