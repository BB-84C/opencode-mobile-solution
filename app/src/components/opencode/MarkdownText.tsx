import MarkdownIt from 'markdown-it';
import Markdown from 'react-native-markdown-display';
import { useMemo } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { palette } from '@/src/ui/palette';

import { markdownStyleSource } from './markdown-theme';
import { SelectableBlock } from './SelectableBlock';
import { SelectableMarkdown } from './SelectableMarkdown';
import { MathHtmlView } from './MathHtmlView';
import { MathView } from './MathView';
import { containsMath, markdownToHtml } from './math-html';
import { mathPlugin } from './markdown-math';

export { markdownStyleSource } from './markdown-theme';

export function MarkdownText({ children, muted = false, testID }: { children: string; muted?: boolean; testID?: string }) {
  // On iOS each block would be its own text view, and a selection cannot leave
  // the view it started in; the whole message has to be one.
  if (Platform.OS === 'ios') {
    return (
      <View testID={testID} style={styles.container}>
        <IosMarkdown source={children} muted={muted} />
      </View>
    );
  }
  return (
    <View testID={testID} style={styles.container}>
      <Markdown markdownit={markdownParser} rules={muted ? mutedRules : selectableRules} style={muted ? mutedMarkdownStyles : markdownStyles}>
        {children}
      </Markdown>
    </View>
  );
}

// iOS decides selectability from the outermost Text of a paragraph only, and
// the library wraps every paragraph in a plain one (textgroup, inline). Marking
// just the leaves left whole paragraphs unselectable on the phone.
// The library's own defaults plus TeX math, so a formula renders instead of
// showing its $...$ source.
const markdownParser = new MarkdownIt({ typographer: true });
mathPlugin(markdownParser);

const mathRules = (color: string) => ({
  math_inline: (node: any) => <MathView key={node.key} tex={String(node.content)} color={color} />,
  math_display: (node: any) => <MathView key={node.key} tex={String(node.content)} color={color} display />,
  math_block: (node: any) => <MathView key={node.key} tex={String(node.content)} color={color} display />,
});

const textRules = {
  textgroup: (node: any, children: any, _parent: any, styles: any) => (
    <Text key={node.key} selectable style={styles.textgroup}>
      {children}
    </Text>
  ),
  inline: (node: any, children: any, _parent: any, styles: any) => (
    <Text key={node.key} selectable style={styles.inline}>
      {children}
    </Text>
  ),
  text: (node: any, _children: any, _parent: any, styles: any, inheritedStyles: any = {}) => (
    <Text key={node.key} selectable style={[inheritedStyles, styles.text]}>
      {node.content}
    </Text>
  ),
  code_inline: (node: any, _children: any, _parent: any, styles: any, inheritedStyles: any = {}) => (
    <Text key={node.key} selectable style={[inheritedStyles, styles.code_inline]}>
      {node.content}
    </Text>
  ),
  code_block: (node: any, _children: any, _parent: any, styles: any, inheritedStyles: any = {}) => (
    <SelectableBlock key={node.key} style={[inheritedStyles, styles.code_block]} text={String(node.content).replace(/\n$/, '')} />
  ),
  fence: (node: any, _children: any, _parent: any, styles: any, inheritedStyles: any = {}) => (
    <SelectableBlock key={node.key} style={[inheritedStyles, styles.fence]} text={String(node.content).replace(/\n$/, '')} />
  ),
};

const selectableRules = { ...textRules, ...mathRules(palette.text) };
const mutedRules = { ...textRules, ...mathRules(palette.textMuted) };

/**
 * iOS: a message with math goes to a WebView, where KaTeX can typeset it; any
 * other message stays one native selectable text view.
 */
function IosMarkdown({ source, muted }: { source: string; muted: boolean }) {
  const bodyHtml = useMemo(() => (containsMath(source) ? markdownToHtml(source) : null), [source]);
  if (bodyHtml === null) return <SelectableMarkdown source={source} muted={muted} />;
  return <MathHtmlView bodyHtml={bodyHtml} muted={muted} estimatedHeight={Math.max(20, source.split('\n').length * 20)} />;
}

const markdownStyles = StyleSheet.create(markdownStyleSource);
const mutedMarkdownStyles = StyleSheet.create({
  ...markdownStyleSource,
  body: { ...markdownStyleSource.body, color: palette.textMuted },
  paragraph: { ...markdownStyleSource.paragraph, color: palette.textMuted },
});

const styles = StyleSheet.create({
  container: {
    flexShrink: 1,
  },
});
