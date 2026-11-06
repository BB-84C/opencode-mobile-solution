import type { StyleProp, TextStyle } from 'react-native';

import { SelectableText } from './SelectableText';

/** A block of verbatim text (code, tool output) that can be partly selected. */
export function SelectableBlock({
  text,
  style,
  testID,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  return (
    <SelectableText testID={testID} style={style}>
      {text}
    </SelectableText>
  );
}
