import { useMemo } from 'react';
import { Linking, StyleSheet, type TextStyle } from 'react-native';

import { palette } from '@/src/ui/palette';

import { markdownStyleSource } from './markdown-theme';
import { markdownToSpans, type SpanKind } from './markdown-spans';
import { SelectableText } from './SelectableText';

/**
 * A whole markdown message as one selectable text view (iOS). Paragraphs, list
 * items and code blocks share one string, so a selection can start in one and
 * end in another, the way it does in a browser.
 */
export function SelectableMarkdown({ source, muted = false }: { source: string; muted?: boolean }) {
  const spans = useMemo(() => markdownToSpans(source), [source]);
  return (
    <SelectableText style={muted ? styles.mutedBody : styles.body}>
      {spans.map((span, index) => (
        <SelectableText
          key={index}
          style={span.kinds.map((kind) => styles[kind])}
          onPress={span.href ? () => openLink(span.href!) : undefined}>
          {span.text}
        </SelectableText>
      ))}
    </SelectableText>
  );
}

function openLink(url: string) {
  Linking.openURL(url).catch((error: unknown) => {
    // Nothing on screen depends on it; a malformed link just does not open.
    console.warn(`could not open ${url}: ${String(error)}`);
  });
}

const theme = markdownStyleSource;
const kindStyles: Record<SpanKind, TextStyle> = {
  heading1: { fontSize: theme.heading1.fontSize, lineHeight: theme.heading1.lineHeight, fontWeight: 'bold' },
  heading2: { fontSize: theme.heading2.fontSize, lineHeight: theme.heading2.lineHeight, fontWeight: 'bold' },
  heading3: { fontSize: theme.heading3.fontSize, lineHeight: theme.heading3.lineHeight, fontWeight: 'bold' },
  strong: { fontWeight: 'bold' },
  em: { fontStyle: 'italic' },
  s: { color: palette.textMuted, textDecorationLine: 'line-through' },
  code: { color: palette.warning, fontFamily: theme.code_inline.fontFamily, fontSize: theme.code_inline.fontSize },
  codeBlock: {
    color: palette.text,
    backgroundColor: palette.backgroundElement,
    fontFamily: theme.fence.fontFamily,
    fontSize: theme.fence.fontSize,
    lineHeight: theme.fence.lineHeight,
  },
  link: { color: palette.primary, textDecorationLine: 'underline' },
  quote: { color: palette.textMuted },
  muted: { color: palette.textMuted },
};

const styles = StyleSheet.create({
  body: { color: theme.body.color, fontSize: theme.body.fontSize, lineHeight: theme.body.lineHeight },
  mutedBody: { color: palette.textMuted, fontSize: theme.body.fontSize, lineHeight: theme.body.lineHeight },
  ...kindStyles,
});
