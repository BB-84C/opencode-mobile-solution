import { useMemo, useState } from 'react';
import {
  FlatList,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ConfiguredModelEntry } from '@/src/opencode/execution-contract';
import { palette } from '@/src/ui/palette';
import { filterConfiguredModels } from '@/src/ux/model-picker';

export function ModelPickerModal({
  visible,
  models,
  selectedKey,
  onClose,
  onSelect,
}: {
  visible: boolean;
  models: readonly ConfiguredModelEntry[];
  selectedKey?: string;
  onClose: () => void;
  onSelect: (model: ConfiguredModelEntry) => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterConfiguredModels(models, query), [models, query]);

  return (
    <Modal
      animationType="slide"
      presentationStyle="fullScreen"
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
      visible={visible}
      onRequestClose={onClose}>
      <SafeAreaView
        testID="model-picker-safe-area"
        edges={['bottom', 'left', 'right']}
        style={[styles.safeArea, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>Model</Text>
            <Text style={styles.subtitle}>{models.length} configured on this machine</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close model picker" testID="model-picker-done" style={styles.doneButton} onPress={onClose}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
        <TextInput
          accessibilityLabel="Search models"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          placeholder="Search model or provider"
          placeholderTextColor={palette.textMuted}
          returnKeyType="search"
          testID="model-picker-search"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={Keyboard.dismiss}
          style={styles.search}
        />
        <FlatList
          data={filtered}
          keyExtractor={(entry) => entry.key}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          initialNumToRender={15}
          maxToRenderPerBatch={15}
          windowSize={7}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={<Text testID="model-picker-empty" style={styles.empty}>No matching configured models.</Text>}
          renderItem={({ item }) => {
            const selected = item.key === selectedKey;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`${item.modelName}, ${item.providerName}`}
                testID={`model-picker-item-${item.key}`}
                style={[styles.row, selected && styles.rowSelected]}
                onPress={() => {
                  onSelect(item);
                  setQuery('');
                  onClose();
                }}>
                <View style={styles.rowCopy}>
                  <Text numberOfLines={1} style={styles.modelName}>{item.modelName}</Text>
                  <Text numberOfLines={1} style={styles.modelID}>{item.modelID}</Text>
                </View>
                <Text numberOfLines={1} style={styles.provider}>{item.providerName}</Text>
                {selected ? <Text style={styles.check}>✓</Text> : null}
              </Pressable>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  header: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.borderSubtle },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { fontSize: 19, lineHeight: 23, fontWeight: '800', color: palette.text },
  subtitle: { fontSize: 11, lineHeight: 14, color: palette.textMuted },
  doneButton: { minWidth: 52, minHeight: 38, alignItems: 'center', justifyContent: 'center' },
  doneText: { fontSize: 15, fontWeight: '700', color: palette.primary },
  search: { minHeight: 40, margin: 10, paddingHorizontal: 10, borderWidth: 1, borderColor: palette.borderSubtle, borderRadius: 9, color: palette.text, backgroundColor: palette.backgroundElement },
  listContent: { paddingHorizontal: 10, paddingBottom: 18, gap: 6 },
  row: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: palette.borderSubtle, borderRadius: 8, backgroundColor: palette.panel },
  rowSelected: { borderColor: palette.primary, backgroundColor: palette.backgroundElement },
  rowCopy: { flex: 1, minWidth: 0 },
  modelName: { fontSize: 13, lineHeight: 17, fontWeight: '700', color: palette.text },
  modelID: { fontSize: 10, lineHeight: 13, color: palette.textMuted },
  provider: { maxWidth: '32%', fontSize: 10, color: palette.accent },
  check: { fontSize: 16, fontWeight: '800', color: palette.primary },
  empty: { padding: 24, textAlign: 'center', color: palette.textMuted },
});
