import type { ReactNode } from 'react';
import { Text } from 'react-native';

export default function MarkdownTestRenderer({ children }: { children?: ReactNode }) {
  return <Text selectable>{children}</Text>;
}
