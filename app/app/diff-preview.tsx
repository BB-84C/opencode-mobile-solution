import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActionModal } from '@/src/components/opencode/ActionModal';
import { TextViewModal } from '@/src/components/opencode/TextViewModal';
import type { FileDiff } from '@/src/opencode/types';
import { sessionStateKey, useOpenCodeMobileStore } from '@/src/store/mobile-store';
import { palette } from '@/src/ui/palette';
import { writeClipboardText } from '@/src/ux/clipboard';
import { createDiffCopyModel } from '@/src/ux/session-diff';

const previewDiffs: FileDiff[] = [
  {
    path: 'src/app.ts',
    hunks: [
      {
        oldStart: 3,
        oldLines: 2,
        newStart: 3,
        newLines: 3,
        lines: [
          { type: 'context', content: 'export function run() {' },
          { type: 'remove', content: '  return "old";' },
          { type: 'add', content: '  const status = "ready";' },
          { type: 'add', content: '  return status;' },
          { type: 'context', content: '}' },
        ],
      },
    ],
  },
];

export default function DiffPreviewScreen() {
  const [actionsVisible, setActionsVisible] = useState(false);
  const [textViewVisible, setTextViewVisible] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const params = useLocalSearchParams<{ connectionId?: string; machine?: string; session?: string }>();
  const diffsByKey = useOpenCodeMobileStore((state) => state.diffs);

  // Addressed by route rather than by whatever session happens to be active, so
  // a diff opened from one session cannot show another session's changes.
  const live = useMemo(() => {
    if (!params.connectionId || !params.session) return null;
    const key = sessionStateKey({
      connectionId: params.connectionId,
      relayTargetID: params.machine ?? '',
      sessionId: params.session,
    });
    return diffsByKey[key] ?? [];
  }, [diffsByKey, params.connectionId, params.machine, params.session]);

  const diffs = live ?? previewDiffs;
  const model = useMemo(() => createDiffCopyModel(diffs), [diffs]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View testID="diff-preview-header" style={styles.header}>
        <Text testID="diff-preview-title" style={styles.title}>Diff preview</Text>
        <Text testID="diff-preview-subtitle" style={styles.muted}>
            {live === null
              ? 'Local fixture for unified diff copy QA.'
              : live.length === 0
                ? 'No file changes recorded for this session.'
                : `${live.length} changed file${live.length === 1 ? '' : 's'} in this session.`}
          </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        testID="diff-preview-open-actions"
        style={styles.diffCard}
        onPress={() => setActionsVisible(true)}>
        <Text style={styles.cardTitle}>{model.changedFiles} changed file</Text>
        <Text selectable style={styles.mono}>
          {model.text}
        </Text>
      </Pressable>
      <ActionModal
        title="Diffs · 1 changed file"
        visible={actionsVisible}
        onClose={() => setActionsVisible(false)}
        onActionError={(error) => setActionError(error instanceof Error ? error.message : String(error))}
        items={model.actions.map((action) => ({
          ...action,
          onPress: async () => {
            setActionError(null);
            if (action.id === 'copy' || action.id === 'copy-raw') await writeClipboardText(model.text);
            if (action.id === 'open-text-view') setTextViewVisible(true);
          },
        }))}
      />
      {actionError ? <Text selectable testID="diff-preview-error" style={styles.error}>{actionError}</Text> : null}
      <TextViewModal title={model.title} text={model.text} visible={textViewVisible} onClose={() => setTextViewVisible(false)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.background,
  },
  content: {
    gap: 12,
    padding: 16,
  },
  header: {
    alignSelf: 'stretch',
    alignItems: 'flex-start',
    width: '100%',
  },
  title: {
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '800',
    color: palette.text,
  },
  muted: {
    alignSelf: 'stretch',
    textAlign: 'left',
    color: palette.textMuted,
  },
  error: {
    color: palette.error,
  },
  diffCard: {
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 8,
    backgroundColor: palette.panel,
  },
  cardTitle: {
    fontWeight: '800',
    color: palette.text,
  },
  mono: {
    fontFamily: 'SpaceMono',
    fontSize: 12,
    lineHeight: 18,
    color: palette.code,
  },
});
