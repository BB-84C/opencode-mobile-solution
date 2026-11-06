// Vitest stand-in for @bsky.app/react-native-uitextview: the real module
// registers native components through codegen, which a Node test cannot load.
import { Text, type TextProps } from 'react-native';

export function UITextView({ uiTextView: _uiTextView, ...props }: TextProps & { uiTextView?: boolean }) {
  return <Text {...props} />;
}
