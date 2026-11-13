import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { palette } from '@/src/ui/palette';

/**
 * A sheet that rises from the bottom, for short forms with a text field.
 *
 * Two things went wrong when the sheet sat inside a tappable scrim:
 * - In the desktop window a mouse click on the sheet (its text field included)
 *   reached the scrim, which closed the sheet the moment the field was clicked.
 *   The scrim is a sibling here, behind the sheet, so a click on the sheet never
 *   reaches it.
 * - A Modal renders outside the screen's KeyboardAvoidingView, so on the phone
 *   the keyboard covered a sheet anchored to the bottom. The sheet has its own.
 */
export function SheetModal({
  visible,
  onClose,
  testID,
  style,
  children,
}: {
  visible: boolean;
  onClose(): void;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <Modal
      animationType="slide"
      transparent
      presentationStyle="overFullScreen"
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
      visible={visible}
      onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.frame} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* The sheet comes first: in a desktop window the modal hands focus to its
            first focusable element, which must be the sheet's text field rather
            than the scrim. zIndex keeps the scrim drawn behind it. */}
        <View testID={testID} style={[styles.sheet, style]}>
          {children}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          testID={testID ? `${testID}-scrim` : undefined}
          style={styles.scrim}
          onPress={onClose}
        />
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 0, backgroundColor: palette.scrim },
  sheet: {
    zIndex: 1,
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 30,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    backgroundColor: palette.panel,
  },
});
