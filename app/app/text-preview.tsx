import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { MessageCard } from '@/src/components/opencode/MessageCard';
import type { MessageWithParts } from '@/src/opencode/types';
import { palette } from '@/src/ui/palette';

const textMessages: MessageWithParts[] = [
  {
    info: { id: 'text-preview-markdown', role: 'assistant', agent: 'build' },
    parts: [
      {
        type: 'text',
        text: [
          'The first paragraph has **bold words**, a [link](https://example.com) and `inline code` in it.',
          '',
          'Second paragraph: select part of this sentence and copy it.',
          '',
          '```ts',
          'const answer = computeTheAnswer(42);',
          'console.log("copy only this line");',
          '```',
        ].join('\n'),
      },
    ],
  },
  {
    info: { id: 'text-preview-math', role: 'assistant', agent: 'build' },
    parts: [
      {
        type: 'text',
        text: [
          'The ground-state energy is $E_0 = \\hbar\\omega/2$, and the fidelity obeys \\(F(\\rho,\\sigma) \\le 1\\). Prices like $5 and $10 stay text.',
          '',
          '$$',
          'Z = \\sum_{n=0}^{\\infty} e^{-\\beta E_n} = \\frac{1}{2\\sinh(\\beta\\hbar\\omega/2)}',
          '$$',
          '',
          'A display formula inside a sentence: $$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$ then more text.',
          '',
          '\\[',
          '\\mathcal{H} = -J \\sum_{\\langle i,j \\rangle} \\mathbf{S}_i \\cdot \\mathbf{S}_j',
          '\\]',
          '',
          'A broken formula $\\frac{1}{$ should not blank the message.',
        ].join('\n'),
      },
    ],
  },
  {
    info: { id: 'text-preview-user', role: 'user' },
    parts: [{ type: 'text', text: 'A user message that should also be selectable.' }],
  },
];

/** Local fixture for checking text selection and copy on a device. */
export default function TextPreviewScreen() {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Text preview</Text>
        <Text style={styles.muted}>Local fixture for selection and copy QA.</Text>
      </View>
      {textMessages.map((message) => (
        <MessageCard key={message.info.id} message={message} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  content: { gap: 12, padding: 16 },
  header: { gap: 4 },
  title: { fontSize: 20, fontWeight: '800', color: palette.text },
  muted: { color: palette.textMuted },
});
