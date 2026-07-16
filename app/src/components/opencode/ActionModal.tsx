import { useCallback, useRef } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { palette } from '@/src/ui/palette';

export interface ActionItem {
  id: string;
  label: string;
  detail?: string;
  danger?: boolean;
  disabled?: boolean;
  interactive?: boolean;
  onPress?(): void | Promise<void>;
}

export function ActionModal({
  title,
  visible,
  items,
  onClose,
  onActionError,
}: {
  title: string;
  visible: boolean;
  items: ActionItem[];
  onClose(): void;
  onActionError?(error: unknown): void;
}) {
  const pendingActionRef = useRef<null | (() => void | Promise<void>)>(null);
  const runPendingAction = useCallback(() => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (!action) return;
    void Promise.resolve()
      .then(action)
      .catch((error) => onActionError?.(error));
  }, [onActionError]);

  function dismissThenRun(action: () => void | Promise<void>) {
    if (pendingActionRef.current) return;
    pendingActionRef.current = action;
    onClose();
    if (Platform.OS !== 'ios') setTimeout(runPendingAction, 0);
  }

  return (
    <Modal
      animationType="slide"
      transparent
      presentationStyle="overFullScreen"
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
      visible={visible}
      onDismiss={runPendingAction}
      onRequestClose={onClose}>
      <Pressable
        accessibilityViewIsModal
        testID="action-modal-scrim"
        style={styles.scrim}
        onPress={onClose}>
        <Pressable
          testID="action-modal-sheet"
          style={styles.sheet}
          onPress={(event) => event.stopPropagation()}>
          <View style={styles.handle} />
          <Text style={styles.title}>{title}</Text>
          <ScrollView
            testID="action-modal-list"
            style={styles.itemList}
            contentContainerStyle={styles.itemListContent}
            keyboardShouldPersistTaps="handled">
            {items.map((item) => {
              const content = (
                <>
                  <Text style={[styles.rowLabel, item.danger && styles.danger, item.disabled && styles.disabledText]}>
                    {item.label}
                  </Text>
                  {item.detail ? <Text style={styles.rowDetail}>{item.detail}</Text> : null}
                </>
              );
              if (item.interactive === false || !item.onPress) {
                return (
                  <View key={item.id} testID={`action-${item.id}`} style={[styles.row, styles.infoRow]}>
                    {content}
                  </View>
                );
              }
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: Boolean(item.disabled) }}
                  testID={`action-${item.id}`}
                  disabled={item.disabled}
                  style={[styles.row, item.disabled && styles.rowDisabled]}
                  onPress={() => {
                    if (item.disabled || !item.onPress) return;
                    dismissThenRun(item.onPress);
                  }}>
                  {content}
                </Pressable>
              );
            })}
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
    gap: 6,
    maxHeight: '84%',
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
    paddingVertical: 10,
    fontSize: 18,
    fontWeight: '700',
    color: palette.text,
  },
  itemList: {
    flexShrink: 1,
  },
  itemListContent: {
    paddingBottom: 4,
  },
  row: {
    minHeight: 48,
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.borderSubtle,
  },
  rowDisabled: {
    opacity: 0.62,
  },
  infoRow: {
    minHeight: 42,
  },
  rowLabel: {
    fontSize: 16,
    color: palette.text,
  },
  rowDetail: {
    marginTop: 2,
    fontSize: 12,
    color: palette.textMuted,
  },
  danger: {
    color: palette.red,
  },
  disabledText: {
    color: palette.textMuted,
  },
});
