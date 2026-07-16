import { memo, useCallback, useRef, useState, type MutableRefObject } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { MessagePart, MessageWithParts, SessionStatus, ToolPart } from '@/src/opencode/types';
import { getMessageActions } from '@/src/ux/tui-actions';
import { partToText } from '@/src/store/mobile-store';
import { palette } from '@/src/ui/palette';
import { writeClipboardText } from '@/src/ux/clipboard';
import { createSubagentCardModel } from '@/src/ux/subagent-card';
import {
  collapseToolOutput,
  createToolTranscriptModel,
  shellOutputCharacterBudget,
  shouldRenderTranscriptPart,
} from '@/src/ux/tool-transcript';
import {
  classifyToolPresentation,
  createTextViewModel,
  createQuestionPromptInteraction,
  getPermissionActions,
  getPendingPermissions,
  getQuestionPromptModel,
  type QuestionPromptModel,
  type QuestionPromptPayload,
  type PermissionActionId,
} from '@/src/ux/session-interactions';

import { ActionModal } from './ActionModal';
import { TextViewModal } from './TextViewModal';
import { MarkdownText } from './MarkdownText';

const shellOutputMaxLines = 10;
const defaultShellContentColumns = 40;
const spaceMonoCharacterWidth = 7.25;

export interface MessageCardProps {
  message: MessageWithParts;
  onPermissionReply?: (permissionId: string, action: PermissionActionId, message?: string) => Promise<void> | void;
  sessionStatuses?: Record<string, SessionStatus>;
  onQuestionReply?: (payload: QuestionPromptPayload) => Promise<void> | void;
  onOpenSubagent?: (sessionId: string) => void;
  onUserMessageAction?: (action: 'fork' | 'revert', messageId: string) => Promise<void> | void;
  onTimeline?: (messageId: string) => void;
  allowFork?: boolean;
  selected?: boolean;
  showActions?: boolean;
  showTimestamps?: boolean;
  renderQuestionsInline?: boolean;
}

type MessageCardCallbacks = Pick<
  MessageCardProps,
  'onPermissionReply' | 'onQuestionReply' | 'onOpenSubagent' | 'onUserMessageAction' | 'onTimeline'
>;

type MessageCardBodyProps = Omit<MessageCardProps, keyof MessageCardCallbacks> & {
  callbacksRef: MutableRefObject<MessageCardCallbacks>;
  hasPermissionReply: boolean;
  hasQuestionReply: boolean;
  hasOpenSubagent: boolean;
  hasUserMessageAction: boolean;
  hasTimeline: boolean;
};

/**
 * This small outer component intentionally updates callback refs on every
 * parent render. The expensive message body below can then stay memoized when
 * an inline callback gets a new identity but its message presentation did not
 * change, without ever dispatching through a stale callback.
 */
export function MessageCard({
  message,
  onPermissionReply,
  sessionStatuses,
  onQuestionReply,
  onOpenSubagent,
  onUserMessageAction,
  onTimeline,
  allowFork = false,
  selected = false,
  showActions = true,
  showTimestamps = false,
  renderQuestionsInline = true,
}: MessageCardProps) {
  const callbacksRef = useRef<MessageCardCallbacks>({
    onPermissionReply,
    onQuestionReply,
    onOpenSubagent,
    onUserMessageAction,
    onTimeline,
  });
  callbacksRef.current = {
    onPermissionReply,
    onQuestionReply,
    onOpenSubagent,
    onUserMessageAction,
    onTimeline,
  };
  return (
    <MemoizedMessageCardBody
      message={message}
      sessionStatuses={sessionStatuses}
      allowFork={allowFork}
      selected={selected}
      showActions={showActions}
      showTimestamps={showTimestamps}
      renderQuestionsInline={renderQuestionsInline}
      callbacksRef={callbacksRef}
      hasPermissionReply={Boolean(onPermissionReply)}
      hasQuestionReply={Boolean(onQuestionReply)}
      hasOpenSubagent={Boolean(onOpenSubagent)}
      hasUserMessageAction={Boolean(onUserMessageAction)}
      hasTimeline={Boolean(onTimeline)}
    />
  );
}

const MemoizedMessageCardBody = memo(MessageCardBody);

function partKey(messageId: string, part: MessagePart, index: number) {
  const id = (part as Record<string, unknown>).id;
  return typeof id === 'string' && id ? `${messageId}-${id}` : `${messageId}-part-${index}`;
}

function MessageCardBody({
  message,
  sessionStatuses,
  allowFork = false,
  selected = false,
  showActions = true,
  showTimestamps = false,
  renderQuestionsInline = true,
  callbacksRef,
  hasPermissionReply,
  hasQuestionReply,
  hasOpenSubagent,
  hasUserMessageAction,
  hasTimeline,
}: MessageCardBodyProps) {
  const invokePermissionReply = useCallback(
    (permissionId: string, action: PermissionActionId, guidance?: string) =>
      callbacksRef.current.onPermissionReply?.(permissionId, action, guidance),
    [callbacksRef],
  );
  const invokeQuestionReply = useCallback(
    (payload: QuestionPromptPayload) => callbacksRef.current.onQuestionReply?.(payload),
    [callbacksRef],
  );
  const invokeOpenSubagent = useCallback(
    (sessionId: string) => callbacksRef.current.onOpenSubagent?.(sessionId),
    [callbacksRef],
  );
  const invokeUserMessageAction = useCallback(
    (action: 'fork' | 'revert', messageId: string) => callbacksRef.current.onUserMessageAction?.(action, messageId),
    [callbacksRef],
  );
  const invokeTimeline = useCallback(
    (messageId: string) => callbacksRef.current.onTimeline?.(messageId),
    [callbacksRef],
  );
  const [actionsVisible, setActionsVisible] = useState(false);
  const [messageTextViewVisible, setMessageTextViewVisible] = useState(false);
  const [messageActionError, setMessageActionError] = useState<string | null>(null);
  const role = message.info.role;
  const rawText = message.parts.map(partToText).join('\n');
  const messageTextView = createTextViewModel({ title: role === 'user' ? 'User message' : 'Message', text: rawText });
  const transcriptRole = role === 'user' ? 'user' : 'assistant';
  const hasNestedControls = message.parts.some((part) => partHasNestedControls(part, renderQuestionsInline));
  const content = (
    <>
      <Text selectable style={styles.meta}>
        {role === 'user' ? 'You' : `Agent${message.info.agent ? ` · ${message.info.agent}` : ''}`}
      </Text>
      {showTimestamps ? (
        <Text selectable testID={`message-timestamp-${message.info.id}`} style={styles.timestamp}>
          {formatMessageTimestamp(message)}
        </Text>
      ) : null}
      {selected ? (
        <Text testID={`message-selected-${message.info.id}`} style={styles.selectedLabel}>
          Timeline target
        </Text>
      ) : null}
      {message.parts.map((part, index) => (
        <PartView
          key={partKey(message.info.id, part, index)}
          messageId={message.info.id}
          partIndex={index}
          part={part}
          onPermissionReply={hasPermissionReply ? invokePermissionReply : undefined}
          onQuestionReply={hasQuestionReply ? invokeQuestionReply : undefined}
          onOpenSubagent={hasOpenSubagent ? invokeOpenSubagent : undefined}
          sessionStatuses={sessionStatuses}
          showActions={showActions}
          renderQuestionsInline={renderQuestionsInline}
        />
      ))}
      {showActions ? (
        <>
          <ActionModal
            title={role === 'user' ? 'User message' : 'Message'}
            visible={actionsVisible}
            onClose={() => setActionsVisible(false)}
            onActionError={(actionError) =>
              setMessageActionError(actionError instanceof Error ? actionError.message : String(actionError))
            }
            items={getMessageActions({
              role: transcriptRole,
              messageId: message.info.id,
              canFork: allowFork && hasUserMessageAction,
              canRevert: hasUserMessageAction,
              canTimeline: hasTimeline,
            }).map((action) => ({
              ...action,
              onPress: async () => {
                setMessageActionError(null);
                if (action.id.startsWith('copy')) await writeClipboardText(rawText);
                if (action.id === 'open-text-view') setMessageTextViewVisible(true);
                if ((action.id === 'revert' || (allowFork && action.id === 'fork')) && role === 'user') {
                  await invokeUserMessageAction(action.id, message.info.id);
                }
                if (action.id === 'timeline') invokeTimeline(message.info.id);
              },
            }))}
          />
          {messageActionError ? (
            <Text selectable testID={`message-action-error-${message.info.id}`} style={styles.errorText}>
              {messageActionError}
            </Text>
          ) : null}
          <TextViewModal
            title={messageTextView.title}
            text={messageTextView.text}
            visible={messageTextViewVisible}
            onClose={() => setMessageTextViewVisible(false)}
          />
        </>
      ) : null}
    </>
  );

  if (hasNestedControls) {
    return (
      <View
        testID={`message-card-${message.info.id}`}
        style={[styles.card, role === 'user' ? styles.userCard : styles.agentCard, selected && styles.selectedCard]}>
        {content}
        {showActions ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Message actions"
            testID={`message-actions-${message.info.id}`}
            style={styles.messageActionsButton}
            onPress={() => setActionsVisible(true)}>
            <Text style={styles.messageActionsText}>...</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      testID={`message-card-${message.info.id}`}
      style={[styles.card, role === 'user' ? styles.userCard : styles.agentCard, selected && styles.selectedCard]}
      onLongPress={() => setActionsVisible(true)}
      onPress={() => {
        if (showActions) setActionsVisible(true);
      }}>
      {content}
    </Pressable>
  );
}

function partHasNestedControls(part: MessagePart, renderQuestionsInline: boolean) {
  if (getQuestionPromptModel(part)) return renderQuestionsInline;
  if (getPendingPermissions([{ info: { id: 'part', role: 'assistant' }, parts: [part] }]).length > 0) return true;
  return part.type === 'tool' || part.type === 'tool_use' || part.type === 'tool_result';
}

const PartView = memo(function PartView({
  messageId,
  partIndex,
  part,
  onPermissionReply,
  onQuestionReply,
  onOpenSubagent,
  sessionStatuses,
  showActions,
  renderQuestionsInline,
}: {
  messageId: string;
  partIndex: number;
  part: MessagePart;
  onPermissionReply?: (permissionId: string, action: PermissionActionId, message?: string) => Promise<void> | void;
  onQuestionReply?: (payload: QuestionPromptPayload) => Promise<void> | void;
  onOpenSubagent?: (sessionId: string) => void;
  sessionStatuses?: Record<string, SessionStatus>;
  showActions: boolean;
  renderQuestionsInline: boolean;
}) {
  const [rejectGuidance, setRejectGuidance] = useState('');
  const [textViewVisible, setTextViewVisible] = useState(false);
  const [permissionSubmitting, setPermissionSubmitting] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [toolActionError, setToolActionError] = useState<string | null>(null);
  const [shellOutputExpanded, setShellOutputExpanded] = useState(false);
  const [shellContentColumns, setShellContentColumns] = useState(defaultShellContentColumns);
  const permission = getPendingPermissions([{ info: { id: 'part', role: 'assistant' }, parts: [part] }])[0];
  if (permission) {
    return (
      <View testID={`permission-card-${permission.id}`} style={styles.permission}>
        <Text selectable style={styles.toolTitle}>
          {permission.title}
        </Text>
        {permission.detail ? (
          <Text selectable style={styles.mono}>
            {permission.detail}
          </Text>
        ) : null}
        <View style={styles.permissionActions}>
          {getPermissionActions().map((action) => (
            <Pressable
              key={action.id}
              accessibilityRole="button"
              testID={`permission-action-${action.id}`}
              disabled={permissionSubmitting || !onPermissionReply}
              style={[
                styles.permissionAction,
                action.id === 'reject' && styles.rejectAction,
                (permissionSubmitting || !onPermissionReply) && styles.permissionActionDisabled,
              ]}
              onPress={async () => {
                if (!onPermissionReply) return;
                setPermissionSubmitting(true);
                setPermissionError(null);
                try {
                  await onPermissionReply(permission.id, action.id, rejectGuidance);
                } catch (error) {
                  setPermissionError(error instanceof Error ? error.message : String(error));
                } finally {
                  setPermissionSubmitting(false);
                }
              }}>
              <Text style={styles.permissionActionText}>{action.label}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput
          value={rejectGuidance}
          onChangeText={setRejectGuidance}
          placeholder="Tell OpenCode what to do differently"
          testID={`permission-reject-guidance-${permission.id}`}
          style={styles.permissionInput}
          multiline
        />
        {permissionError ? (
          <Text selectable testID={`permission-error-${permission.id}`} style={styles.errorText}>
            {permissionError}
          </Text>
        ) : null}
      </View>
    );
  }

  const question = getQuestionPromptModel(part);
  if (question) {
    if (!renderQuestionsInline) return null;
    return <QuestionPromptCard question={question} onQuestionReply={onQuestionReply} />;
  }

  if (part.type === 'step-start' || part.type === 'step-finish' || part.type === 'snapshot') {
    return null;
  }

  if (!shouldRenderTranscriptPart(part)) return null;

  if (part.type === 'text') {
    return <MarkdownText testID={`message-text-${messageId}-${partIndex}`}>{String(part.text)}</MarkdownText>;
  }

  if (part.type === 'reasoning') {
    return (
      <View style={styles.reasoning}>
        <Text selectable testID={`reasoning-title-${messageId}-${partIndex}`} style={styles.reasoningTitle}>
          Thinking
        </Text>
        <MarkdownText muted testID={`reasoning-text-${messageId}-${partIndex}`}>
          {partToText(part)}
        </MarkdownText>
      </View>
    );
  }

  if (part.type === 'tool' || part.type === 'tool_use' || part.type === 'tool_result') {
    const tool = stringValue((part as { tool?: unknown }).tool);
    const presentation = classifyToolPresentation(tool);
    const toolModel = createToolTranscriptModel(part as ToolPart);
    const rawText = toolModel.rawText;
    const readableText = toolModel.visibleText;
    const collapsedShellOutput = toolModel.shell
      ? collapseToolOutput(
          toolModel.shell.output,
          shellOutputMaxLines,
          shellOutputCharacterBudget(shellContentColumns, shellOutputMaxLines),
        )
      : undefined;
    const shellOutput = toolModel.shell
      ? shellOutputExpanded || !collapsedShellOutput?.overflow
        ? toolModel.shell.output
        : collapsedShellOutput.output
      : undefined;
    const textView = createTextViewModel({ title: tool ?? part.type, text: rawText });
    const subagent = createSubagentCardModel(part as Extract<MessagePart, { type: 'tool' | 'tool_use' | 'tool_result' }>, {
      statuses: sessionStatuses,
    });
    const toolContent = (
      <>
        <Text selectable style={styles.toolTitle}>
          {subagent?.title ?? toolModel.title}
        </Text>
        {subagent ? (
          <View style={styles.subagentDetails}>
            {subagent.detailLines.map((line) => (
              <Text key={line} selectable style={styles.subagentDetail}>
                {line}
              </Text>
            ))}
          </View>
        ) : null}
        {toolModel.shell ? (
          <View
            testID={`tool-shell-${messageId}-${partIndex}`}
            onLayout={(event) => {
              const columns = Math.max(20, Math.floor(event.nativeEvent.layout.width / spaceMonoCharacterWidth));
              setShellContentColumns((current) => current === columns ? current : columns);
            }}>
            {toolModel.shell.command ? (
              <Text selectable testID={`tool-command-${messageId}-${partIndex}`} style={styles.mono}>
                {`$ ${toolModel.shell.command}`}
              </Text>
            ) : null}
            {toolModel.shell.output ? (
              <Pressable
                accessibilityRole={collapsedShellOutput?.overflow ? 'button' : undefined}
                accessibilityLabel={collapsedShellOutput?.overflow
                  ? shellOutputExpanded ? 'Collapse shell output' : 'Expand shell output'
                  : undefined}
                disabled={!collapsedShellOutput?.overflow}
                testID={`tool-output-toggle-${messageId}-${partIndex}`}
                onPress={() => setShellOutputExpanded((expanded) => !expanded)}>
                <Text selectable testID={`tool-output-${messageId}-${partIndex}`} style={styles.mono}>
                  {shellOutput}
                </Text>
                {collapsedShellOutput?.overflow ? (
                  <Text testID={`tool-output-toggle-label-${messageId}-${partIndex}`} style={styles.toolExpandLabel}>
                    {shellOutputExpanded ? 'Click to collapse' : 'Click to expand'}
                  </Text>
                ) : null}
              </Pressable>
            ) : !toolModel.shell.command ? (
              <Text selectable testID={`tool-output-${messageId}-${partIndex}`} style={styles.mono}>
                {readableText}
              </Text>
            ) : null}
          </View>
        ) : (
          <Text selectable testID={`tool-output-${messageId}-${partIndex}`} style={styles.mono}>
            {readableText}
          </Text>
        )}
        {showActions ? (
          <View style={styles.toolCopyControls}>
            <Pressable
              accessibilityRole="button"
              testID={`tool-copy-${tool ?? part.type}`}
              style={styles.toolCopyButton}
              onPress={async (event) => {
                event?.stopPropagation?.();
                setToolActionError(null);
                try {
                  await writeClipboardText(readableText);
                } catch (error) {
                  setToolActionError(error instanceof Error ? error.message : String(error));
                }
              }}>
              <Text style={styles.toolCopyButtonText}>Copy</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              testID={`tool-copy-raw-${tool ?? part.type}`}
              style={styles.toolCopyButton}
              onPress={async (event) => {
                event?.stopPropagation?.();
                setToolActionError(null);
                try {
                  await writeClipboardText(rawText);
                } catch (error) {
                  setToolActionError(error instanceof Error ? error.message : String(error));
                }
              }}>
              <Text style={styles.toolCopyButtonText}>Copy raw</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              testID={`tool-open-text-view-${tool ?? part.type}`}
              style={styles.toolCopyButton}
              onPress={(event) => {
                event?.stopPropagation?.();
                setTextViewVisible(true);
              }}>
              <Text style={styles.toolCopyButtonText}>Open text view</Text>
            </Pressable>
          </View>
        ) : null}
        {subagent ? (
          <Text style={[styles.toolLink, subagent.action.type === 'disabled' && styles.toolLinkDisabled]}>
            {subagent.action.label}
            {subagent.action.type === 'disabled' ? ` · ${subagent.action.detail}` : ''}
          </Text>
        ) : null}
        {toolActionError ? <Text selectable testID={`tool-action-error-${messageId}-${partIndex}`} style={styles.errorText}>{toolActionError}</Text> : null}
        <TextViewModal
          title={textView.title}
          text={textView.text}
          visible={textViewVisible}
          onClose={() => setTextViewVisible(false)}
        />
      </>
    );
    const toolProps = {
      testID: `tool-${presentation.layout}-${tool ?? part.type}`,
      style: [styles.tool, presentation.layout === 'block' && styles.toolBlock],
    };
    if (subagent?.action.type === 'navigate') {
      const navigateAction = subagent.action;
      return (
        <Pressable
          {...toolProps}
          accessibilityRole="button"
          accessibilityLabel={navigateAction.label}
          disabled={!onOpenSubagent}
          onPress={() => onOpenSubagent?.(navigateAction.sessionId)}>
          {toolContent}
        </Pressable>
      );
    }
    return <View {...toolProps}>{toolContent}</View>;
  }

  if (part.type === 'compaction') {
    return (
      <Text selectable testID={`message-compaction-${messageId}-${partIndex}`} style={styles.compaction}>
        Context compacted
      </Text>
    );
  }

  if (part.type === 'error') {
    return (
      <Text selectable testID={`message-raw-${messageId}-${partIndex}`} style={styles.errorText}>
        {stringValue((part as Record<string, unknown>).message) ?? 'OpenCode error'}
      </Text>
    );
  }

  return null;
});

export function QuestionPromptCard({
  question,
  onQuestionReply,
}: {
  question: QuestionPromptModel;
  onQuestionReply?: (payload: QuestionPromptPayload) => Promise<void> | void;
}) {
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [customAnswer, setCustomAnswer] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [submittedPayload, setSubmittedPayload] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const interaction = createQuestionPromptInteraction(question);
  selectedOptions.forEach((option) => interaction.toggleOption(option));
  interaction.setCustomAnswer(customAnswer);
  interaction.setConfirmed(confirmed);
  const canSubmit = interaction.canSubmit();

  return (
    <View testID={`question-card-${question.id}`} style={styles.question}>
      <Text selectable style={styles.toolTitle}>
        {question.title}
      </Text>
      <Text style={styles.permissionHint}>
        {question.mode === 'multi' ? 'Multiple answers' : question.mode === 'confirm' ? 'Confirm answer' : 'Choose an answer'}
        {question.allowCustom ? ' · custom allowed' : ''}
      </Text>
      {question.options.map((option) => {
        const selected = selectedOptions.includes(option);
        return (
          <Pressable
            key={option}
            accessibilityRole={question.mode === 'multi' ? 'checkbox' : 'radio'}
            testID={`question-option-${question.id}-${option}`}
            style={[styles.questionOptionButton, selected && styles.questionOptionSelected]}
            onPress={() => {
              if (question.mode === 'single') {
                setSelectedOptions([option]);
                return;
              }
              setSelectedOptions((current) =>
                current.includes(option) ? current.filter((item) => item !== option) : [...current, option],
              );
            }}>
            <Text style={[styles.questionOptionText, selected && styles.questionOptionSelectedText]}>{option}</Text>
          </Pressable>
        );
      })}
      {question.mode === 'custom' || question.allowCustom ? (
        <TextInput
          value={customAnswer}
          onChangeText={setCustomAnswer}
          placeholder="Type a custom answer"
          testID={`question-custom-${question.id}`}
          style={styles.questionInput}
          multiline
        />
      ) : null}
      {question.mode === 'confirm' ? (
        <Pressable
          accessibilityRole="checkbox"
          testID={`question-confirm-${question.id}`}
          style={[styles.questionOptionButton, confirmed && styles.questionOptionSelected]}
          onPress={() => setConfirmed((value) => !value)}>
          <Text style={[styles.questionOptionText, confirmed && styles.questionOptionSelectedText]}>Confirm</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        testID={`question-submit-${question.id}`}
        disabled={!canSubmit || !onQuestionReply || submitting}
        style={[styles.questionSubmit, (!canSubmit || !onQuestionReply || submitting) && styles.questionSubmitDisabled]}
        onPress={async () => {
          const payload = interaction.createPayload();
          if (!payload || !onQuestionReply || submitting) return;
          setSubmitError(null);
          setSubmitting(true);
          try {
            await onQuestionReply(payload);
            setSubmittedPayload(JSON.stringify(payload));
          } catch (error) {
            setSubmitError(error instanceof Error ? error.message : String(error));
          } finally {
            setSubmitting(false);
          }
        }}>
        <Text style={styles.questionSubmitText}>{submitting ? 'Submitting…' : submittedPayload ? 'Submitted' : 'Submit answer'}</Text>
      </Pressable>
      {submitError ? (
        <Text selectable testID={`question-error-${question.id}`} style={styles.errorText}>
          {submitError}
        </Text>
      ) : null}
      {submittedPayload ? (
        <Text selectable testID={`question-payload-${question.id}`} style={styles.mono}>
          {submittedPayload}
        </Text>
      ) : null}
    </View>
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function formatMessageTimestamp(message: MessageWithParts) {
  if (message.info.created) return message.info.created;
  if (typeof message.info.time?.created === 'number') return new Date(message.info.time.created).toISOString();
  return 'timestamp unavailable';
}

const styles = StyleSheet.create({
  card: {
    gap: 7,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  compaction: {
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.borderActive,
    color: palette.textMuted,
    textAlign: 'center',
  },
  userCard: {
    paddingVertical: 10,
    borderLeftWidth: 2,
    borderLeftColor: palette.secondary,
    backgroundColor: palette.panel,
  },
  agentCard: {
    paddingLeft: 12,
  },
  meta: {
    fontSize: 12,
    fontWeight: '700',
    color: palette.textMuted,
  },
  timestamp: {
    fontSize: 12,
    color: palette.textMuted,
  },
  selectedLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: palette.primary,
  },
  selectedCard: {
    borderColor: palette.primary,
    backgroundColor: palette.selectedBg,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    color: palette.text,
  },
  reasoning: {
    gap: 4,
    paddingVertical: 4,
  },
  reasoningTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: palette.textMuted,
  },
  tool: {
    gap: 5,
    paddingVertical: 4,
  },
  toolBlock: {
    padding: 9,
    borderLeftWidth: 2,
    borderLeftColor: palette.borderActive,
    backgroundColor: palette.backgroundElement,
  },
  toolTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: palette.text,
  },
  toolLink: {
    color: palette.primary,
    fontWeight: '700',
  },
  toolLinkDisabled: {
    color: palette.textMuted,
  },
  toolExpandLabel: {
    paddingTop: 4,
    fontSize: 11,
    color: palette.textMuted,
  },
  subagentDetails: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  subagentDetail: {
    paddingRight: 8,
    fontSize: 12,
    color: palette.textMuted,
  },
  toolCopyControls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  toolCopyButton: {
    minHeight: 26,
    justifyContent: 'center',
    paddingRight: 8,
  },
  toolCopyButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: palette.primary,
  },
  messageActionsButton: {
    alignSelf: 'flex-start',
    minWidth: 28,
    minHeight: 24,
    justifyContent: 'center',
  },
  messageActionsText: {
    fontSize: 12,
    fontWeight: '700',
    color: palette.textMuted,
  },
  permission: {
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: palette.warning,
    borderRadius: 8,
    backgroundColor: palette.warningBg,
  },
  permissionActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  permissionAction: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    overflow: 'hidden',
    borderRadius: 8,
    backgroundColor: palette.primary,
  },
  permissionActionText: {
    fontWeight: '800',
    color: palette.foregroundOnAccent,
  },
  rejectAction: {
    backgroundColor: palette.red,
  },
  permissionInput: {
    minHeight: 42,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: palette.borderActive,
    borderRadius: 8,
    color: palette.text,
    backgroundColor: palette.backgroundElement,
  },
  permissionHint: {
    fontSize: 12,
    color: palette.textMuted,
  },
  question: {
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: palette.info,
    borderRadius: 8,
    backgroundColor: palette.infoBg,
  },
  questionOption: {
    padding: 8,
    borderRadius: 6,
    color: palette.text,
    backgroundColor: palette.backgroundElement,
  },
  questionOptionButton: {
    padding: 8,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    borderRadius: 6,
    backgroundColor: palette.backgroundElement,
  },
  questionOptionSelected: {
    borderColor: palette.primary,
    backgroundColor: palette.selectedBg,
  },
  questionOptionText: {
    color: palette.text,
  },
  permissionActionDisabled: {
    opacity: 0.45,
  },
  questionOptionSelectedText: {
    fontWeight: '800',
    color: palette.primary,
  },
  questionInput: {
    minHeight: 42,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: palette.borderActive,
    borderRadius: 8,
    color: palette.text,
    backgroundColor: palette.backgroundElement,
  },
  questionSubmit: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: palette.primary,
  },
  questionSubmitDisabled: {
    opacity: 0.45,
  },
  questionSubmitText: {
    fontWeight: '800',
    color: palette.foregroundOnAccent,
  },
  mono: {
    fontFamily: 'SpaceMono',
    fontSize: 12,
    lineHeight: 18,
    color: palette.code,
  },
  errorText: {
    color: palette.red,
  },
});
