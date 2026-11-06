import { Text } from 'react-native';

/**
 * Native fallback: the formula's source, with its delimiters, so it reads and
 * copies the way the model wrote it. The web build renders it with KaTeX
 * (MathView.web.tsx).
 */
export function MathView({ tex, display = false, color }: { tex: string; display?: boolean; color?: string }) {
  return <Text selectable style={{ color }}>{display ? `$$${tex}$$` : `$${tex}$`}</Text>;
}
