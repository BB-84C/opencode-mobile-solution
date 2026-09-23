import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';

import { ActionModal } from '@/src/components/opencode/ActionModal';
import { MessageCard } from '@/src/components/opencode/MessageCard';
import { ModelPickerModal } from '@/src/components/opencode/ModelPickerModal';
import { QuestionRequestCard } from '@/src/components/opencode/QuestionRequestCard';
import { PermissionRequestCard } from '@/src/components/opencode/PermissionRequestCard';
import {
  VirtualizedTranscript,
  type VirtualizedTranscriptHandle,
} from '@/src/components/opencode/VirtualizedTranscript';
import {
  flattenConfiguredModels,
  isSelectableAgent,
  modelRefKey,
  variantsForModel,
} from '@/src/opencode/execution-contract';
import type { FileReference, MessageWithParts } from '@/src/opencode/types';
import {
  decodeSessionStateKey,
  executionScopeKey,
  sessionStateKey,
  useOpenCodeMobileStore,
} from '@/src/store/mobile-store';
import { palette } from '@/src/ui/palette';
import { appendClipboardText, enterFileReferenceMode } from '@/src/ux/prompt-accessories';
import { applyPromptSuggestion, getPromptAssistTrigger } from '@/src/ux/prompt-assist';
import { createPromptAssistContext } from '@/src/ux/prompt-context';
import { sortMessagesChronologically } from '@/src/ux/message-order';
import { findRedoMessageId, findUndoMessageId } from '@/src/ux/session-revert';
import { createSessionExportArtifact } from '@/src/ux/session-export';
import {
  buildSessionForest,
  decodeSessionRouteKey,
  encodeSessionRouteKey,
  findSessionNode,
  flattenSessionTree,
  sessionKey as routeSessionKey,
  type SessionForestNode,
  type SessionRef,
} from '@/src/ux/session-forest';
import {
  getPendingPermissions,
  isPromptBlocked,
  type PermissionActionId,
  type QuestionPromptPayload,
} from '@/src/ux/session-interactions';
import { createSessionSubagentListModel } from '@/src/ux/session-subagents';
import {
  growTranscriptWindow,
  INITIAL_TRANSCRIPT_WINDOW,
  selectTranscriptWindow,
} from '@/src/ux/transcript-window';

export default function SessionScreen() {
  const { sessionKey: encodedRouteKey } = useLocalSearchParams<{ sessionKey?: string }>();
  const ref = useMemo(
    () => decodeSessionRouteKey(Array.isArray(encodedRouteKey) ? encodedRouteKey[0] : encodedRouteKey ?? ''),
    [encodedRouteKey],
  );
  const store = useOpenCodeMobileStore(useShallow((state) => ({
    hydrated: state.hydrated,
    activeConnectionId: state.activeConnectionId,
    activeSessionKey: state.activeSessionKey,
    connections: state.connections,
    sessions: state.sessions,
    sessionStatuses: state.sessionStatuses,
    messages: state.messages,
    messageNextCursors: state.messageNextCursors,
    olderMessageLoadStates: state.olderMessageLoadStates,
    olderMessageErrors: state.olderMessageErrors,
    questions: state.questions,
    permissions: state.permissions,
    permissionErrors: state.permissionErrors,
    sessionLoadStates: state.sessionLoadStates,
    sessionErrors: state.sessionErrors,
    eventConnectionStates: state.eventConnectionStates,
    machineContracts: state.machineContracts,
    contractLoadStates: state.contractLoadStates,
    sessionSelections: state.sessionSelections,
    projects: state.projects,
    promptMode: state.promptMode,
    setActiveConnection: state.setActiveConnection,
    openSession: state.openSession,
    loadOlderMessages: state.loadOlderMessages,
    subscribeToActiveHost: state.subscribeToActiveHost,
    unsubscribeFromHost: state.unsubscribeFromHost,
    searchFileReferences: state.searchFileReferences,
    sendPrompt: state.sendPrompt,
    respondToPermission: state.respondToPermission,
    respondToQuestion: state.respondToQuestion,
    rejectQuestion: state.rejectQuestion,
    revertMessage: state.revertMessage,
    unrevertSession: state.unrevertSession,
    renameSession: state.renameSession,
    shareSession: state.shareSession,
    compactSession: state.compactSession,
    copySessionTranscript: state.copySessionTranscript,
    setSessionAgent: state.setSessionAgent,
    setSessionModel: state.setSessionModel,
    setSessionVariant: state.setSessionVariant,
    togglePromptMode: state.togglePromptMode,
    requestInterrupt: state.requestInterrupt,
  })));
  const [prompt, setPrompt] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [menuVisible, setMenuVisible] = useState(false);
  const [agentVisible, setAgentVisible] = useState(false);
  const [modelVisible, setModelVisible] = useState(false);
  const [variantVisible, setVariantVisible] = useState(false);
  const [commandsVisible, setCommandsVisible] = useState(false);
  const [hierarchyVisible, setHierarchyVisible] = useState(false);
  const [subagentsVisible, setSubagentsVisible] = useState(false);
  const [renameVisible, setRenameVisible] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [showActions, setShowActions] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [fileReferences, setFileReferences] = useState<FileReference[]>([]);
  const [transcriptAtBottom, setTranscriptAtBottom] = useState(true);
  const [transcriptWindowSize, setTranscriptWindowSize] = useState(INITIAL_TRANSCRIPT_WINDOW);
  const transcriptRef = useRef<VirtualizedTranscriptHandle>(null);

  const activeHost = ref ? store.connections.find((connection) => connection.id === ref.connectionId) : undefined;
  const hostSessions = ref ? store.sessions[ref.connectionId] ?? [] : [];
  const forest = useMemo(
    () => ref ? buildSessionForest(hostSessions, ref.connectionId) : null,
    [hostSessions, ref],
  );
  const node = ref && forest ? findSessionNode(forest, ref) : undefined;
  const treeRows = useMemo(() => {
    if (!forest || !node || !ref) return [];
    return flattenSessionTree(forest, { currentRef: ref, roots: [sessionTreeRoot(node)] });
  }, [forest, node, ref]);
  const session = node?.session;
  const key = ref ? sessionStateKey(ref) : '';
  const directory = session?.location?.directory ?? session?.directory ?? session?.path;
  const scopeKey = ref ? executionScopeKey(ref, directory) : '';
  const contract = scopeKey ? store.machineContracts[scopeKey] : undefined;
  const contractState = scopeKey ? store.contractLoadStates[scopeKey] : undefined;
  const contractFresh = contractState?.status === 'fresh';
  const selection = key ? store.sessionSelections[key] : undefined;
  const catalog = useMemo(
    () => contract ? flattenConfiguredModels({ providers: contract.providers, default: contract.providerDefaults }) : [],
    [contract],
  );
  const selectionModel = selection?.model;
  const selectedModel = selectionModel
    ? catalog.find((entry) => entry.key === modelRefKey(selectionModel))
    : undefined;
  const variants = useMemo(
    () => selection?.model && contract
      ? variantsForModel({ providers: contract.providers, default: contract.providerDefaults }, selection.model)
      : [undefined],
    [contract, selection?.model],
  );
  const rawTranscript = key ? store.messages[key] ?? [] : [];
  const transcript = useMemo(() => sortMessagesChronologically(rawTranscript), [rawTranscript]);
  const renderedTranscript = useMemo(
    () => selectTranscriptWindow(transcript, transcriptWindowSize),
    [transcript, transcriptWindowSize],
  );
  const status = key ? store.sessionStatuses[key] : undefined;
  const questions = key ? store.questions[key] ?? [] : [];
  const permissions = key ? store.permissions?.[key] ?? [] : [];
  const permissionError = key ? store.permissionErrors?.[key] : null;
  const loadState = key ? store.sessionLoadStates[key] : undefined;
  const nextMessageCursor = key ? store.messageNextCursors[key] : null;
  const olderMessageLoadState = key ? store.olderMessageLoadStates[key] : undefined;
  const olderMessageError = key ? store.olderMessageErrors[key] : null;
  const sessionError = key ? store.sessionErrors[key] : null;
  const connectionState = key ? store.eventConnectionStates[key] : undefined;
  const running = isRunningStatus(status);
  const pendingPermissions = useMemo(() => getPendingPermissions(transcript), [transcript]);
  const promptBlocked = isPromptBlocked(transcript) || permissions.length > 0 || questions.length > 0;
  const canSend = Boolean(ref && contract && contractFresh && selection?.agentName && selection.model && prompt.trim() && !promptBlocked);
  const targetStatuses = useMemo(() => {
    if (!ref) return {};
    return Object.fromEntries(
      Object.entries(store.sessionStatuses).flatMap(([stateKey, value]) => {
        const candidate = decodeSessionStateKey(stateKey);
        return candidate
          && candidate.connectionId === ref.connectionId
          && candidate.relayTargetID === ref.relayTargetID
          ? [[candidate.sessionId, value]]
          : [];
      }),
    );
  }, [ref, store.sessionStatuses]);
  const subagents = useMemo(
    () => createSessionSubagentListModel(transcript, { statuses: targetStatuses }),
    [targetStatuses, transcript],
  );
  const promptAssist = useMemo(
    () => createPromptAssistContext({
      prompt,
      commands: contract?.commands ?? [],
      agents: contract?.agents ?? [],
      sessions: hostSessions.filter((candidate) => candidate.relayTargetID === ref?.relayTargetID),
      workspaces: ref ? store.projects[ref.connectionId] ?? [] : [],
      files: fileReferences,
    }),
    [contract?.agents, contract?.commands, fileReferences, hostSessions, prompt, ref, store.projects],
  );
  const currentRevertMessageId = session?.revert?.messageID ?? null;
  const undoMessageId = findUndoMessageId(transcript, currentRevertMessageId);
  const redoMessageId = findRedoMessageId(transcript, currentRevertMessageId);

  useEffect(() => {
    if (!ref || !activeHost) return;
    if (store.activeConnectionId !== ref.connectionId) {
      store.setActiveConnection(ref.connectionId);
      return;
    }
    void store.openSession(ref);
  }, [activeHost, ref, store.activeConnectionId, store.openSession, store.setActiveConnection]);

  useEffect(() => {
    if (!ref || store.activeSessionKey !== key) return;
    store.subscribeToActiveHost();
    return () => store.unsubscribeFromHost(ref.connectionId);
  }, [key, ref, store.activeSessionKey, store.subscribeToActiveHost, store.unsubscribeFromHost]);

  useEffect(() => {
    setTranscriptAtBottom(true);
    setTranscriptWindowSize(INITIAL_TRANSCRIPT_WINDOW);
  }, [key]);

  const revealOlderTranscript = useCallback(() => {
    if (transcriptWindowSize < transcript.length) {
      setTranscriptWindowSize((current) => growTranscriptWindow(current, transcript.length));
      return;
    }
    if (!ref || !nextMessageCursor || olderMessageLoadState === 'loading') return;
    void store.loadOlderMessages(ref).then(() => {
      setTranscriptWindowSize((current) => growTranscriptWindow(current, Number.MAX_SAFE_INTEGER));
    });
  }, [nextMessageCursor, olderMessageLoadState, ref, store.loadOlderMessages, transcript.length, transcriptWindowSize]);

  useEffect(() => {
    const trigger = getPromptAssistTrigger(prompt);
    if (!ref || trigger?.trigger !== '@' || !trigger.query.trim()) {
      setFileReferences([]);
      return;
    }
    let cancelled = false;
    void store.searchFileReferences(trigger.query.trim(), ref).then((files) => {
      if (!cancelled) setFileReferences(files);
    });
    return () => {
      cancelled = true;
    };
  }, [prompt, ref, store.searchFileReferences]);

  const reportError = useCallback((error: unknown) => {
    setActionError(error instanceof Error ? error.message : String(error));
  }, []);

  const navigateTo = useCallback((next: SessionRef) => {
    if (ref && routeSessionKey(ref) === routeSessionKey(next)) return;
    Keyboard.dismiss();
    router.replace({
      pathname: '/session/[sessionKey]' as never,
      params: { sessionKey: encodeSessionRouteKey(next) },
    });
  }, [ref]);

  const navigateToChild = useCallback((sessionId: string) => {
    if (!ref || !forest) return;
    const child = findSessionNode(forest, { ...ref, sessionId });
    if (!child) {
      setActionError(`Child session ${sessionId} is not available on ${session?.relayTargetName ?? ref.relayTargetID}.`);
      return;
    }
    navigateTo(child.ref);
  }, [forest, navigateTo, ref, session?.relayTargetName]);

  const handleBack = useCallback(() => {
    if (node?.parent) navigateTo(node.parent.ref);
    else router.replace('/two');
  }, [navigateTo, node?.parent]);

  const handlePermissionReply = useCallback(
    (permissionId: string, action: PermissionActionId, message?: string) => {
      if (!ref) return;
      return store.respondToPermission(ref, permissionId, action, message);
    },
    [ref, store.respondToPermission],
  );
  const handleQuestionReply = useCallback(
    (payload: QuestionPromptPayload) => {
      if (!ref) return;
      return store.respondToQuestion(ref, payload);
    },
    [ref, store.respondToQuestion],
  );
  const handleUserMessageAction = useCallback(
    async (action: 'fork' | 'revert', messageId: string) => {
      if (action === 'revert' && ref) await store.revertMessage(ref, messageId);
    },
    [ref, store.revertMessage],
  );
  const transcriptExtraData = useMemo(
    () => ({ showActions, showTimestamps, status, questionCount: questions.length }),
    [questions.length, showActions, showTimestamps, status],
  );
  const renderTranscriptItem = useCallback(
    ({ item }: { item: MessageWithParts }) => (
      <MessageCard
        message={item}
        sessionStatuses={targetStatuses}
        allowFork={false}
        showActions={showActions}
        showTimestamps={showTimestamps}
        renderQuestionsInline={false}
        onOpenSubagent={navigateToChild}
        onPermissionReply={handlePermissionReply}
        onQuestionReply={handleQuestionReply}
        onUserMessageAction={handleUserMessageAction}
      />
    ),
    [
      handlePermissionReply,
      handleQuestionReply,
      handleUserMessageAction,
      navigateToChild,
      showActions,
      showTimestamps,
      targetStatuses,
    ],
  );

  if (!ref) {
    return <RouteError title="Invalid session link" detail="The link does not include a complete relay, machine, and session identity." />;
  }
  if (!store.hydrated) {
    return <RouteLoading />;
  }
  if (!activeHost) {
    return <RouteError title="Relay unavailable" detail="This session belongs to a relay that is no longer configured on this phone." />;
  }
  if (!session) {
    return <RouteError title="Session unavailable" detail={`The selected session is not present on machine ${ref.relayTargetID}.`} />;
  }

  return (
    <SafeAreaView testID="session-safe-area" edges={['top', 'bottom', 'left', 'right']} style={styles.safeArea}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.select({ ios: 'padding', default: undefined })}>
        <View testID="session-header" style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel={node?.parent ? 'Back to parent session' : 'Back to sessions'} testID="session-back-button" style={styles.iconButton} onPress={handleBack}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          <Pressable accessibilityRole="button" testID="session-hierarchy-button" style={styles.headerCopy} onPress={() => setHierarchyVisible(true)}>
            <Text numberOfLines={1} style={styles.title}>{session.title || session.id}</Text>
            <Text numberOfLines={1} ellipsizeMode="middle" style={styles.subtitle}>
              {session.relayTargetName ?? ref.relayTargetID} · {directory ?? 'unknown directory'}
            </Text>
          </Pressable>
          {loadState === 'loading' ? <ActivityIndicator testID="session-header-loading" size="small" color={palette.primary} /> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Session menu" testID="session-overflow-button" style={styles.iconButton} onPress={() => setMenuVisible(true)}>
            <SymbolView name={{ ios: 'ellipsis.circle', android: 'more_horiz', web: 'more_horiz' }} tintColor={palette.text} size={23} />
          </Pressable>
        </View>

        {connectionState === 'reconciling' || connectionState === 'connecting' ? (
          <Text testID="session-reconnecting-banner" style={styles.notice}>Reconnecting live updates…</Text>
        ) : null}
        {connectionState === 'offline' && transcript.length > 0 ? (
          <Text testID="session-offline-cache-banner" style={styles.warning}>Live updates disconnected · transcript remains available</Text>
        ) : null}
        {!contractState || contractState.status === 'loading' || contractState.status === 'unverified' ? (
          <Text testID="session-contract-loading" style={styles.notice}>Verifying this machine&apos;s agents, models, and reasoning variants…</Text>
        ) : null}
        {contractState?.status === 'stale' || contractState?.status === 'error' ? (
          <Text selectable testID="session-contract-warning" style={styles.warning}>
            Machine execution contract {contractState.status} · sending is disabled{contractState.error ? ` · ${contractState.error}` : ''}
          </Text>
        ) : null}
        {sessionError ? <Text selectable testID="session-load-warning" style={styles.warning}>Transcript refresh warning · {sessionError}</Text> : null}
        {olderMessageLoadState === 'loading' ? <Text testID="session-older-loading" style={styles.notice}>Loading older messages…</Text> : null}
        {olderMessageError ? <Text selectable testID="session-older-error" style={styles.warning}>Older transcript warning · {olderMessageError}</Text> : null}
        {actionError ? <Text selectable testID="session-action-error" style={styles.error}>{actionError}</Text> : null}

        <View style={styles.transcriptFrame}>
          <VirtualizedTranscript
            ref={transcriptRef}
            transcriptKey={key}
            data={renderedTranscript}
            isLoading={loadState === 'loading'}
            emptyLabel="No messages in this existing session"
            keyExtractor={messageKey}
            extraData={transcriptExtraData}
            style={styles.transcript}
            renderItem={renderTranscriptItem}
            onBottomStateChange={setTranscriptAtBottom}
            onOlderEndReached={revealOlderTranscript}
          />
          {!transcriptAtBottom ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Scroll to latest message"
              testID="session-scroll-to-latest"
              style={styles.scrollToLatest}
              onPress={() => transcriptRef.current?.scrollToLatest()}>
              <SymbolView name={{ ios: 'arrow.down', android: 'arrow_downward', web: 'arrow_downward' }} tintColor={palette.foregroundOnAccent} size={15} />
              <Text style={styles.scrollToLatestText}>Latest</Text>
            </Pressable>
          ) : null}
        </View>

        {permissions.length > 0 || questions.length > 0 || permissionError ? (
          <ScrollView testID="session-question-surface" style={styles.questions} contentContainerStyle={styles.questionContent} keyboardShouldPersistTaps="handled">
            {permissionError ? <Text selectable style={styles.error}>{permissionError}</Text> : null}
            {permissions.map((request) => (
              <PermissionRequestCard key={request.id} request={request} onReply={handlePermissionReply} />
            ))}
            {questions.map((question) => (
              <QuestionRequestCard
                key={question.id}
                request={question}
                onReply={(payload) => store.respondToQuestion(ref, payload)}
                onReject={(requestID) => store.rejectQuestion(ref, requestID)}
              />
            ))}
          </ScrollView>
        ) : null}

        <View testID="session-prompt-surface" style={styles.promptDock}>
          {promptAssist?.suggestions.length ? (
            <ScrollView testID="session-prompt-assist" style={styles.suggestions} keyboardShouldPersistTaps="handled">
              {promptAssist.suggestions.slice(0, 5).map((suggestion) => (
                <Pressable key={suggestion.id} style={styles.suggestion} onPress={() => setPrompt(applyPromptSuggestion(prompt, suggestion))}>
                  <Text style={styles.suggestionTitle}>{suggestion.label}</Text>
                  {suggestion.detail ? <Text style={styles.subtitle}>{suggestion.detail}</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
          <View style={styles.promptRow}>
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              placeholder={store.promptMode === 'shell' ? 'Shell command…' : 'Message existing session…'}
              placeholderTextColor={palette.textMuted}
              multiline
              testID="session-prompt-input"
              style={styles.promptInput}
            />
            <Pressable accessibilityRole="button" accessibilityLabel="Hide keyboard" testID="session-dismiss-keyboard" style={styles.smallButton} onPress={Keyboard.dismiss}>
              <SymbolView name={{ ios: 'keyboard.chevron.compact.down', android: 'keyboard_hide', web: 'keyboard_hide' }} tintColor={palette.textMuted} size={17} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Attach file reference"
              testID="session-accessory-attach"
              style={styles.smallButton}
              onPress={() => setPrompt((current) => enterFileReferenceMode(current))}>
              <SymbolView name={{ ios: 'paperclip', android: 'attach_file', web: 'attach_file' }} tintColor={palette.textMuted} size={17} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Paste"
              testID="session-accessory-paste"
              style={styles.smallButton}
              onPress={async () => {
                const text = await Clipboard.getStringAsync().catch(() => '');
                if (text) setPrompt((current) => appendClipboardText(current, text));
              }}>
              <SymbolView name={{ ios: 'doc.on.clipboard', android: 'content_paste', web: 'content_paste' }} tintColor={palette.textMuted} size={17} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              testID="send-prompt-button"
              disabled={!canSend}
              style={[styles.sendButton, !canSend && styles.disabled]}
              onPress={async () => {
                if (!canSend) return;
                const text = prompt;
                setPrompt('');
                setActionError(null);
                try {
                  const sent = await store.sendPrompt(text);
                  if (!sent) setPrompt((current) => current || text);
                } catch (error) {
                  setPrompt((current) => current || text);
                  reportError(error);
                }
              }}>
              <SymbolView name={{ ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }} tintColor={palette.foregroundOnAccent} size={19} />
            </Pressable>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.metadata} testID="session-prompt-metadata">
            <MetaButton testID="agent-chip" label={selection?.agentName ?? 'Loading agent…'} accent onPress={() => setAgentVisible(true)} />
            <MetaButton testID="model-chip" label={selectedModel?.modelName ?? selection?.model?.modelID ?? 'Loading model…'} onPress={() => setModelVisible(true)} />
            <MetaButton testID="thinking-chip" label={selection?.variant ?? 'Default'} warning onPress={() => setVariantVisible(true)} />
            <MetaButton testID="shell-mode-chip" label={store.promptMode} onPress={store.togglePromptMode} />
            {running ? <ActivityIndicator testID="session-running-spinner" size="small" color={palette.primary} /> : null}
            {running ? (
              <MetaButton
                testID="interrupt-button"
                label="Stop"
                warning
                onPress={async () => {
                  const result = await store.requestInterrupt(ref);
                  if (result === 'armed') setActionError('Tap Stop again within five seconds to interrupt this session.');
                  else setActionError(null);
                }}
              />
            ) : null}
            {pendingPermissions.length + permissions.length ? <Text style={styles.permission}>{pendingPermissions.length + permissions.length} permission pending</Text> : null}
          </ScrollView>
        </View>

        <ActionModal
          title="Session"
          visible={menuVisible}
          onClose={() => setMenuVisible(false)}
          onActionError={reportError}
          items={[
            { id: 'hierarchy', label: 'Conversation tree', detail: `${node.children.length} child session${node.children.length === 1 ? '' : 's'}`, onPress: () => setHierarchyVisible(true) },
            { id: 'commands', label: 'Commands', detail: `${contract?.commands.length ?? 0} from this machine`, onPress: () => setCommandsVisible(true) },
            { id: 'subagents', label: 'Subagents', detail: `${subagents.entries.length} transcript${subagents.entries.length === 1 ? '' : 's'}`, onPress: () => setSubagentsVisible(true) },
            { id: 'rename', label: 'Rename', onPress: () => { setRenameTitle(session.title ?? ''); setRenameVisible(true); } },
            { id: 'share', label: 'Copy share link', onPress: async () => { const url = await store.shareSession(ref); if (url) await Clipboard.setStringAsync(url); } },
            { id: 'compact', label: 'Compact context', disabled: !selection?.model, onPress: () => store.compactSession(ref) },
            { id: 'undo', label: 'Undo last user message', disabled: !undoMessageId, onPress: () => undoMessageId ? store.revertMessage(ref, undoMessageId) : undefined },
            { id: 'redo', label: 'Redo', disabled: !currentRevertMessageId, onPress: () => redoMessageId ? store.revertMessage(ref, redoMessageId) : store.unrevertSession(ref) },
            { id: 'copy', label: 'Copy transcript', onPress: async () => Clipboard.setStringAsync(store.copySessionTranscript(ref)) },
            { id: 'export', label: 'Export transcript', onPress: async () => Clipboard.setStringAsync(createSessionExportArtifact({ session, messages: transcript })) },
            { id: 'toggle-actions', label: showActions ? 'Hide message actions' : 'Show message actions', onPress: () => setShowActions((value) => !value) },
            { id: 'toggle-time', label: showTimestamps ? 'Hide timestamps' : 'Show timestamps', onPress: () => setShowTimestamps((value) => !value) },
          ]}
        />

        <ActionModal
          title="Conversation tree"
          visible={hierarchyVisible}
          onClose={() => setHierarchyVisible(false)}
          onActionError={reportError}
          items={treeRows.map((row) => ({
            id: `tree-${row.key}`,
            label: `${treePrefix(row.depth)}${row.session.title || row.ref.sessionId}`,
            detail: [
              row.isCurrent ? 'Current session' : row.depth === 0 ? 'Root session' : `Depth ${row.depth}`,
              row.anomalies.length ? `Recovered ${row.anomalies.join(', ')}` : undefined,
            ].filter(Boolean).join(' · '),
            interactive: !row.isCurrent,
            onPress: row.isCurrent ? undefined : () => navigateTo(row.ref),
          }))}
        />

        <ActionModal
          title="Agent"
          visible={agentVisible}
          onClose={() => setAgentVisible(false)}
          onActionError={reportError}
          items={(contract?.agents ?? []).filter(isSelectableAgent).map((agent) => ({
            id: `agent-${agent.name}`,
            label: agent.name,
            detail: agent.description,
            onPress: () => { store.setSessionAgent(ref, agent.name); },
          }))}
        />

        <ModelPickerModal
          visible={modelVisible}
          models={catalog}
          selectedKey={selection?.model ? modelRefKey(selection.model) : undefined}
          onClose={() => setModelVisible(false)}
          onSelect={(model) => store.setSessionModel(ref, model.ref)}
        />

        <ActionModal
          title="Reasoning"
          visible={variantVisible}
          onClose={() => setVariantVisible(false)}
          onActionError={reportError}
          items={variants.map((variant) => ({
            id: `variant-${variant ?? 'default'}`,
            label: variant ?? 'Default',
            detail: variant === selection?.variant || (!variant && !selection?.variant) ? 'Selected' : undefined,
            onPress: () => { store.setSessionVariant(ref, variant); },
          }))}
        />

        <ActionModal
          title="Commands"
          visible={commandsVisible}
          onClose={() => setCommandsVisible(false)}
          onActionError={reportError}
          items={(contract?.commands.length ? contract.commands : [{ name: '', description: 'No commands reported by this machine' }]).map((command) => ({
            id: `command-${command.name || 'empty'}`,
            label: command.name ? `/${command.name}` : command.description ?? 'No commands',
            detail: command.name ? command.description : undefined,
            interactive: Boolean(command.name),
            onPress: command.name ? () => setPrompt(`/${command.name} `) : undefined,
          }))}
        />

        <ActionModal
          title={subagents.title}
          visible={subagentsVisible}
          onClose={() => setSubagentsVisible(false)}
          onActionError={reportError}
          items={subagents.empty
            ? [{ id: 'subagents-empty', label: 'No subagent transcripts', interactive: false }]
            : subagents.entries.map((entry) => ({
                id: entry.id,
                label: entry.label,
                detail: entry.detail,
                disabled: entry.disabled,
                onPress: entry.sessionId ? () => navigateToChild(entry.sessionId!) : undefined,
              }))}
        />

        <Modal transparent animationType="slide" presentationStyle="overFullScreen" visible={renameVisible} onRequestClose={() => setRenameVisible(false)}>
          <Pressable style={styles.scrim} onPress={() => setRenameVisible(false)}>
            <SafeAreaView edges={['bottom']} style={styles.renameSheet} onTouchEnd={(event) => event.stopPropagation()}>
              <Text style={styles.sheetTitle}>Rename session</Text>
              <TextInput value={renameTitle} onChangeText={setRenameTitle} testID="rename-session-input" style={styles.renameInput} />
              <Pressable
                accessibilityRole="button"
                testID="rename-session-submit"
                disabled={!renameTitle.trim() || renameSubmitting}
                style={[styles.renameButton, (!renameTitle.trim() || renameSubmitting) && styles.disabled]}
                onPress={async () => {
                  setRenameSubmitting(true);
                  try {
                    await store.renameSession(ref, renameTitle);
                    setRenameVisible(false);
                  } catch (error) {
                    reportError(error);
                  } finally {
                    setRenameSubmitting(false);
                  }
                }}>
                <Text style={styles.renameButtonText}>{renameSubmitting ? 'Renaming…' : 'Rename'}</Text>
              </Pressable>
            </SafeAreaView>
          </Pressable>
        </Modal>

        {loadState === 'loading' && transcript.length === 0 ? (
          <View pointerEvents="auto" testID="session-loading-blocker" style={styles.loadingBlocker}>
            <ActivityIndicator color={palette.primary} />
            <Text style={styles.loadingText}>Loading transcript…</Text>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function messageKey(message: MessageWithParts) {
  return message.info.id;
}

function sessionTreeRoot(node: SessionForestNode) {
  let root = node;
  const visited = new Set<string>();
  while (root.parent && !visited.has(root.key)) {
    visited.add(root.key);
    root = root.parent;
  }
  return root;
}

function treePrefix(depth: number) {
  if (depth <= 0) return '● ';
  return `${'  '.repeat(Math.max(0, depth - 1))}↳ `;
}

function MetaButton({ testID, label, onPress, accent, warning }: { testID: string; label: string; onPress: () => void; accent?: boolean; warning?: boolean }) {
  return (
    <Pressable accessibilityRole="button" testID={testID} style={styles.metaButton} onPress={onPress}>
      <Text numberOfLines={1} style={[styles.metaText, accent && styles.metaAccent, warning && styles.metaWarning]}>{label}</Text>
    </Pressable>
  );
}

function RouteError({ title, detail }: { title: string; detail: string }) {
  return (
    <SafeAreaView style={styles.routeError}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{detail}</Text>
      <Pressable accessibilityRole="button" style={styles.renameButton} onPress={() => router.replace('/two')}>
        <Text style={styles.renameButtonText}>Back to Sessions</Text>
      </Pressable>
    </SafeAreaView>
  );
}

function RouteLoading() {
  return (
    <SafeAreaView testID="session-route-loading" style={styles.routeError}>
      <ActivityIndicator color={palette.primary} size="small" />
      <Text style={styles.subtitle}>Loading paired relay and session…</Text>
    </SafeAreaView>
  );
}

function isRunningStatus(status: unknown) {
  if (!status || typeof status !== 'object') return false;
  const record = status as Record<string, unknown>;
  return record.type === 'busy' || record.type === 'retry' || record.running === true;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  screen: { flex: 1, position: 'relative', backgroundColor: palette.background },
  header: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 6, paddingVertical: 3, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.borderSubtle, backgroundColor: palette.panel },
  headerCopy: { flex: 1, minWidth: 0, paddingVertical: 2 },
  iconButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 32, lineHeight: 32, color: palette.primary },
  title: { fontSize: 14, lineHeight: 18, fontWeight: '800', color: palette.text },
  subtitle: { fontSize: 10, lineHeight: 13, color: palette.textMuted },
  transcriptFrame: { flex: 1, position: 'relative' },
  transcript: { flex: 1 },
  scrollToLatest: { position: 'absolute', right: 10, bottom: 10, minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 12, borderRadius: 18, backgroundColor: palette.primary },
  scrollToLatestText: { fontSize: 12, fontWeight: '800', color: palette.foregroundOnAccent },
  notice: { paddingHorizontal: 9, paddingVertical: 4, fontSize: 10, color: palette.info, backgroundColor: palette.infoBg },
  warning: { paddingHorizontal: 9, paddingVertical: 5, fontSize: 10, color: palette.warning, backgroundColor: palette.warningBg },
  error: { paddingHorizontal: 9, paddingVertical: 5, fontSize: 10, color: palette.error },
  questions: { flexGrow: 0, maxHeight: '40%', backgroundColor: palette.panel },
  questionContent: { gap: 7, padding: 8 },
  promptDock: { gap: 3, marginHorizontal: 6, marginBottom: 2, paddingHorizontal: 6, paddingVertical: 4, borderLeftWidth: 2, borderLeftColor: palette.accent, backgroundColor: palette.backgroundElement },
  promptRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  promptInput: { flex: 1, minHeight: 34, maxHeight: 84, paddingHorizontal: 3, paddingVertical: 5, fontSize: 13, color: palette.text },
  smallButton: { width: 28, height: 30, alignItems: 'center', justifyContent: 'center' },
  sendButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: palette.primary },
  disabled: { opacity: 0.4 },
  metadata: { minHeight: 24, alignItems: 'center', gap: 4, paddingRight: 8 },
  metaButton: { maxWidth: 160, minHeight: 23, justifyContent: 'center', paddingHorizontal: 4, borderRadius: 5, backgroundColor: palette.panel },
  metaText: { fontSize: 10, lineHeight: 13, fontWeight: '700', color: palette.text },
  metaAccent: { color: palette.accent },
  metaWarning: { color: palette.warning },
  permission: { fontSize: 10, fontWeight: '700', color: palette.red },
  suggestions: { maxHeight: 110, borderWidth: 1, borderColor: palette.borderSubtle, borderRadius: 7, backgroundColor: palette.backgroundMenu },
  suggestion: { gap: 1, paddingHorizontal: 8, paddingVertical: 5 },
  suggestionTitle: { fontSize: 11, fontWeight: '700', color: palette.text },
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: palette.scrim },
  renameSheet: { gap: 9, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 12, backgroundColor: palette.panel },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: palette.text },
  renameInput: { minHeight: 42, paddingHorizontal: 10, borderWidth: 1, borderColor: palette.borderActive, borderRadius: 8, color: palette.text, backgroundColor: palette.backgroundElement },
  renameButton: { minHeight: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, borderRadius: 8, backgroundColor: palette.primary },
  renameButtonText: { fontWeight: '800', color: palette.foregroundOnAccent },
  loadingBlocker: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: palette.scrim },
  loadingText: { fontSize: 13, fontWeight: '800', color: palette.text },
  routeError: { flex: 1, justifyContent: 'center', gap: 10, padding: 24, backgroundColor: palette.background },
});
