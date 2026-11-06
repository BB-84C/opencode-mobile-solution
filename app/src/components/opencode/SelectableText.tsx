import { UITextView } from '@bsky.app/react-native-uitextview';
import type { TextProps } from 'react-native';

/**
 * Text the user can select any part of, like a web page.
 *
 * React Native's own Text on iOS is a label: `selectable` only offers "Copy" for
 * the whole string. This renders a UITextView there instead, which has the
 * system selection handles. Nested SelectableText children become styled runs
 * inside the same view, so one selection can span all of them. On the web and
 * Android it is an ordinary selectable Text.
 */
export function SelectableText(props: TextProps) {
  return <UITextView selectable uiTextView {...props} />;
}
