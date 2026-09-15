import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { executionScopeKey, useOpenCodeMobileStore } from '@/src/store/mobile-store';
import { palette } from '@/src/ui/palette';
import { buildDeviceSelectionModel, isDeviceChoiceSelectable } from '@/src/ux/device-selection';
import { encodeSessionRouteKey } from '@/src/ux/session-forest';
import {
  buildSessionCreationOptions,
  validateSessionCreation,
  type CreationMachine,
} from '@/src/ux/session-creation';

export default function NewSessionScreen() {
  const store = useOpenCodeMobileStore();
  const [machine, setMachine] = useState<CreationMachine | null>(null);
  const [directory, setDirectory] = useState('');
  const [agentName, setAgentName] = useState<string | undefined>();
  const [modelKey, setModelKey] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const machines = useMemo(
    () => buildDeviceSelectionModel({ connections: store.connections, relayTargets: store.relayTargets })
      .groups.flatMap((group) => group.choices)
      .filter(isDeviceChoiceSelectable),
    [store.connections, store.relayTargets],
  );

  // The contract is cached per machine and directory, not per session, so a new
  // session can read one that an earlier session already fetched.
  const options = useMemo(() => {
    if (!machine) return buildSessionCreationOptions(undefined);
    const key = executionScopeKey(
      { connectionId: machine.connectionId, relayTargetID: machine.targetId },
      directory.trim() || undefined,
    );
    return buildSessionCreationOptions(store.machineContracts[key]);
  }, [machine, directory, store.machineContracts]);

  const create = async () => {
    const validation = validateSessionCreation({ machine, directory, agentName, modelKey }, options);
    if (!validation.ok) {
      setError(validation.reason);
      return;
    }
    setBusy(true);
    setError(null);
    const ref = await store.createSession(validation.plan.create);
    setBusy(false);
    if (!ref) {
      setError(store.error ?? 'Could not create the session');
      return;
    }
    // Creation cannot carry these, so they are applied once the session exists.
    if (validation.plan.apply.agentName) store.setSessionAgent(ref, validation.plan.apply.agentName);
    if (validation.plan.apply.model) store.setSessionModel(ref, validation.plan.apply.model);
    router.push({ pathname: '/session/[sessionKey]', params: { sessionKey: encodeSessionRouteKey(ref) } });
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text testID="new-session-title" style={styles.title}>New session</Text>

        <Text style={styles.label}>Machine</Text>
        {machines.length === 0 ? (
          <Text style={styles.muted}>No machine is reachable right now.</Text>
        ) : (
          machines.map((choice) => {
            const selected = machine?.targetId === choice.targetId && machine?.connectionId === choice.hostId;
            return (
              <Pressable
                key={`${choice.hostId}:${choice.targetId}`}
                accessibilityRole="button"
                testID={`new-session-machine-${choice.targetId}`}
                style={[styles.row, selected && styles.rowSelected]}
                onPress={() => setMachine({
                  connectionId: choice.hostId,
                  targetId: choice.targetId,
                  targetName: choice.targetName,
                })}>
                <Text style={styles.rowText}>{`${choice.hostName} · ${choice.targetName}`}</Text>
              </Pressable>
            );
          })
        )}

        <Text style={styles.label}>Working directory</Text>
        <TextInput
          testID="new-session-directory"
          value={directory}
          onChangeText={setDirectory}
          placeholder={options.defaultDirectory ?? '/path/to/project'}
          placeholderTextColor={palette.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />

        <Text style={styles.label}>Agent</Text>
        {options.contractMissing ? (
          <Text testID="new-session-agents-unavailable" style={styles.muted}>
            {machine
              ? 'This machine has not reported its agents yet. The session will start on its defaults.'
              : 'Choose a machine to see its agents.'}
          </Text>
        ) : (
          options.agents.map((agent) => (
            <Pressable
              key={agent.name}
              accessibilityRole="button"
              testID={`new-session-agent-${agent.name}`}
              style={[styles.row, (agentName ?? options.defaultAgentName) === agent.name && styles.rowSelected]}
              onPress={() => setAgentName(agent.name)}>
              <Text style={styles.rowText}>{agent.name}</Text>
              {agent.description ? <Text style={styles.muted}>{agent.description}</Text> : null}
            </Pressable>
          ))
        )}

        <Text style={styles.label}>Model</Text>
        {options.contractMissing ? (
          <Text style={styles.muted}>Available once the machine reports its providers.</Text>
        ) : (
          options.models.map((model) => (
            <Pressable
              key={model.key}
              accessibilityRole="button"
              testID={`new-session-model-${model.key}`}
              style={[styles.row, (modelKey ?? options.defaultModelKey) === model.key && styles.rowSelected]}
              onPress={() => setModelKey(model.key)}>
              <Text style={styles.rowText}>{model.label}</Text>
            </Pressable>
          ))
        )}

        {error ? <Text testID="new-session-error" style={styles.error}>{error}</Text> : null}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          testID="new-session-create"
          disabled={busy}
          style={[styles.create, busy && styles.createBusy]}
          onPress={create}>
          <Text style={styles.createText}>{busy ? 'Creating…' : 'Create session'}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  content: { padding: 16, gap: 10 },
  title: { fontSize: 22, fontWeight: '800', color: palette.text, marginBottom: 4 },
  label: { fontSize: 12, fontWeight: '800', color: palette.textMuted, marginTop: 10 },
  muted: { fontSize: 12, color: palette.textMuted },
  row: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: palette.backgroundElement, gap: 2 },
  rowSelected: { borderWidth: 1, borderColor: palette.primary },
  rowText: { fontSize: 14, fontWeight: '700', color: palette.text },
  input: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: palette.backgroundElement, color: palette.text, fontSize: 14 },
  error: { fontSize: 12, color: palette.error, marginTop: 8 },
  create: { marginTop: 16, paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: palette.primary },
  createBusy: { opacity: 0.6 },
  createText: { fontSize: 14, fontWeight: '800', color: palette.foregroundOnAccent },
});
