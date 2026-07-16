import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { MessageCard } from '@/src/components/opencode/MessageCard';
import type { MessageWithParts } from '@/src/opencode/types';
import { palette } from '@/src/ui/palette';

const subagentMessages: MessageWithParts[] = [
  {
    info: { id: 'subagent-with-session', role: 'assistant', agent: 'orchestrator' },
    parts: [
      {
        type: 'tool',
        tool: 'task',
        state: {
          metadata: {
            sessionId: 'child-session-1',
            toolCallCount: 4,
            elapsedMs: 2_400,
          },
          input: {
            prompt: 'Inspect the diff and report risks.',
          },
        },
      },
    ],
  },
  {
    info: { id: 'subagent-without-session', role: 'assistant', agent: 'orchestrator' },
    parts: [
      {
        type: 'tool_use',
        tool: 'task',
        state: {
          input: {
            prompt: 'Run a read-only audit.',
          },
        },
      },
    ],
  },
];

export default function SubagentPreviewScreen() {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Subagent preview</Text>
        <Text style={styles.muted}>Local fixture for Task card transcript QA.</Text>
      </View>
      {subagentMessages.map((message) => (
        <MessageCard
          key={message.info.id}
          message={message}
          sessionStatuses={{
            'child-session-1': { type: 'busy' },
          }}
        />
      ))}
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
});
