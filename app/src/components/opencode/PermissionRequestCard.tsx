import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { PermissionRequest } from '@/src/opencode/types';
import { palette } from '@/src/ui/palette';
import { getPermissionActions, type PermissionActionId } from '@/src/ux/session-interactions';

export function PermissionRequestCard({ request, onReply }: {
  request: PermissionRequest;
  onReply: (id: string, action: PermissionActionId, guidance?: string) => Promise<void> | void;
}) {
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [guidance, setGuidance] = useState('');
  const [error, setError] = useState<string | null>(null);
  const command = typeof request.metadata?.command === 'string' ? request.metadata.command : undefined;

  return (
    <View testID={`permission-request-${request.id}`} style={styles.card}>
      <Text style={styles.title}>Permission required · {request.permission}</Text>
      {command ? <Text selectable style={styles.command}>{command}</Text> : null}
      <Text selectable style={styles.detail}>{request.patterns.join('\n')}</Text>
      {request.always?.length ? (
        <Text selectable style={styles.detail}>Allow always covers: {request.always.join(', ')}</Text>
      ) : null}
      <View style={styles.actions}>
        {getPermissionActions().filter((action) => action.id !== 'allow-always' || request.always?.length).map((action) => (
          <Pressable
            key={action.id}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            testID={`permission-request-${request.id}-${action.id}`}
            disabled={submitting}
            style={[styles.button, submitting && styles.disabled]}
            onPress={async () => {
              if (submittingRef.current) return;
              submittingRef.current = true;
              setSubmitting(true);
              setError(null);
              try {
                await onReply(request.id, action.id, action.id === 'reject' ? guidance : undefined);
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : String(reason));
              } finally {
                submittingRef.current = false;
                setSubmitting(false);
              }
            }}>
            <Text style={styles.buttonText}>{action.label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        testID={`permission-request-${request.id}-guidance`}
        placeholder="Optional guidance when rejecting"
        placeholderTextColor={palette.textMuted}
        value={guidance}
        onChangeText={setGuidance}
        editable={!submitting}
        multiline
        style={styles.input}
      />
      {error ? <Text selectable testID={`permission-request-${request.id}-error`} style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 10, gap: 7, borderWidth: 1, borderColor: palette.primary, borderRadius: 8, backgroundColor: palette.panel },
  title: { fontSize: 12, fontWeight: '700', color: palette.primary },
  command: { fontSize: 12, fontFamily: 'SpaceMono', color: palette.text },
  detail: { fontSize: 11, lineHeight: 15, color: palette.textMuted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { paddingVertical: 9, paddingHorizontal: 12, borderRadius: 6, backgroundColor: palette.primary },
  buttonText: { fontSize: 12, fontWeight: '700', color: palette.foregroundOnAccent },
  disabled: { opacity: 0.5 },
  input: { borderWidth: 1, borderColor: palette.border, padding: 8, borderRadius: 6, color: palette.text, fontSize: 11 },
  error: { color: palette.error, fontSize: 11 },
});
