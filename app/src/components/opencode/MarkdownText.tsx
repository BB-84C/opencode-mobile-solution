import Markdown from 'react-native-markdown-display';
import { StyleSheet, Text, View } from 'react-native';

import { palette } from '@/src/ui/palette';

import { markdownStyleSource } from './markdown-theme';

export { markdownStyleSource } from './markdown-theme';

export function MarkdownText({ children, muted = false, testID }: { children: string; muted?: boolean; testID?: string }) {
  return (
    <View testID={testID} style={styles.container}>
      <Markdown rules={selectableRules} style={muted ? mutedMarkdownStyles : markdownStyles}>
        {children}
      </Markdown>
    </View>
  );
}

const selectableRules = {
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
    <Text key={node.key} selectable style={[inheritedStyles, styles.code_block]}>
      {String(node.content).replace(/\n$/, '')}
    </Text>
  ),
  fence: (node: any, _children: any, _parent: any, styles: any, inheritedStyles: any = {}) => (
    <Text key={node.key} selectable style={[inheritedStyles, styles.fence]}>
      {String(node.content).replace(/\n$/, '')}
    </Text>
  ),
};

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
