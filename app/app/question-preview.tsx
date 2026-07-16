import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { QuestionRequestCard } from '@/src/components/opencode/QuestionRequestCard';
import type { QuestionRequest } from '@/src/opencode/types';
import { palette } from '@/src/ui/palette';

const questionRequests: QuestionRequest[] = [
  {
    id: 'preview-multi-page',
    sessionID: 'preview-session',
    questions: [
      {
        header: 'Target',
        question: 'Choose a deployment target',
        options: [
          { label: 'staging', description: 'Validate without production traffic' },
          { label: 'production', description: 'Deploy to the live environment' },
        ],
        custom: true,
      },
      {
        header: 'Checks',
        question: 'Select the checks to run',
        options: [
          { label: 'tests', description: 'Run the automated suite' },
          { label: 'lint', description: 'Run static analysis' },
        ],
        multiple: true,
        custom: true,
      },
    ],
  },
  {
    id: 'preview-custom',
    sessionID: 'preview-session',
    questions: [
      {
        header: 'Details',
        question: 'Describe any additional safeguards',
        options: [],
        custom: true,
      },
    ],
  },
];

export default function QuestionPreviewScreen() {
  const [visibleRequests, setVisibleRequests] = useState(questionRequests);
  const [result, setResult] = useState<string | null>(null);

  function finishRequest(requestID: string, resultText: string) {
    setVisibleRequests((current) => current.filter((request) => request.id !== requestID));
    setResult(resultText);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>QuestionPrompt preview</Text>
        <Text style={styles.muted}>Local fixture for TUI question interaction QA.</Text>
      </View>
      {result ? <Text selectable testID="question-preview-result" style={styles.success}>{result}</Text> : null}
      {visibleRequests.map((request) => (
        <QuestionRequestCard
          key={request.id}
          request={request}
          onReply={() => finishRequest(request.id, `${request.id} submitted`)}
          onReject={() => finishRequest(request.id, `${request.id} rejected`)}
        />
      ))}
      {visibleRequests.length === 0 ? <Text style={styles.muted}>All preview requests resolved.</Text> : null}
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
  success: {
    color: palette.success,
  },
});
