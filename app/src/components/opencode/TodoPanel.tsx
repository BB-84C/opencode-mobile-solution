import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { TodoItem } from '@/src/opencode/types';
import { palette } from '@/src/ui/palette';
import { createTodoBoardModel, type TodoState } from '@/src/ux/todo-board';

/**
 * The session's todo list, as the TUI sidebar shows it: a bar with progress and
 * the task in progress, which expands to the whole list. Nothing renders when
 * the agent has made no list.
 */
export function TodoPanel({
  todos,
  expanded,
  onToggle,
}: {
  todos: readonly TodoItem[] | undefined;
  expanded: boolean;
  onToggle(): void;
}) {
  const board = createTodoBoardModel(todos);
  if (board.total === 0) return null;
  return (
    <View testID="todo-panel" style={styles.panel}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={expanded ? 'Collapse todos' : 'Expand todos'}
        testID="todo-panel-toggle"
        style={styles.bar}
        onPress={onToggle}>
        <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
        <Text style={styles.heading}>Todos</Text>
        <Text testID="todo-panel-progress" style={[styles.progress, board.allDone && styles.done]}>
          {board.finished}/{board.total}
        </Text>
        <Text numberOfLines={1} testID="todo-panel-summary" style={[styles.summary, board.current && styles.summaryActive]}>
          {board.summary}
        </Text>
      </Pressable>
      {expanded ? (
        <ScrollView testID="todo-panel-list" style={styles.list} contentContainerStyle={styles.listContent}>
          {board.rows.map((row) => (
            <View key={row.key} testID={`todo-row-${row.state}`} style={styles.row}>
              <Text style={[styles.marker, stateStyles[row.state]]}>{row.marker}</Text>
              <Text selectable style={[styles.content, stateStyles[row.state], row.state === 'cancelled' && styles.struck]}>
                {row.content}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

const stateStyles: Record<TodoState, { color: string; fontWeight?: '700' }> = {
  completed: { color: palette.textMuted },
  in_progress: { color: palette.warning, fontWeight: '700' },
  pending: { color: palette.text },
  cancelled: { color: palette.textMuted },
};

const styles = StyleSheet.create({
  panel: {
    marginHorizontal: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderRadius: 8,
    borderColor: palette.borderSubtle,
    backgroundColor: palette.backgroundPanel,
  },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7 },
  chevron: { width: 12, fontSize: 12, color: palette.textMuted },
  heading: { fontSize: 12, fontWeight: '800', color: palette.text },
  progress: { fontSize: 12, fontWeight: '700', color: palette.primary },
  done: { color: palette.success },
  summary: { flex: 1, fontSize: 12, color: palette.textMuted },
  summaryActive: { color: palette.warning },
  list: { maxHeight: 220, borderTopWidth: 1, borderTopColor: palette.borderSubtle },
  listContent: { gap: 4, paddingHorizontal: 10, paddingVertical: 8 },
  row: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  marker: { fontFamily: 'SpaceMono', fontSize: 12, lineHeight: 18 },
  content: { flex: 1, fontSize: 13, lineHeight: 18 },
  struck: { textDecorationLine: 'line-through' },
});
