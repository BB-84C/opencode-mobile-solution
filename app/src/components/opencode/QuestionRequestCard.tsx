import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { QuestionRequest } from '@/src/opencode/types';
import { palette } from '@/src/ui/palette';
import { createQuestionRequestModel, createQuestionSubmission, type QuestionSubmission } from '@/src/ux/question-request';

export function QuestionRequestCard({
  request,
  onReply,
  onReject,
}: {
  request: QuestionRequest;
  onReply: (submission: QuestionSubmission) => Promise<void> | void;
  onReject?: (requestID: string) => Promise<void> | void;
}) {
  const model = useMemo(() => createQuestionRequestModel(request), [request]);
  const [tab, setTab] = useState(0);
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ''));
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const confirm = tab === request.questions.length;
  const question = request.questions[tab];

  async function submit(nextAnswers = answers) {
    setSubmitting(true);
    setRequestError(null);
    try {
      await onReply(createQuestionSubmission(request, nextAnswers));
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function reject() {
    if (!onReject) return;
    setSubmitting(true);
    setRequestError(null);
    try {
      await onReject(request.id);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  function selectOption(label: string) {
    if (!question) return;
    if (question.multiple) {
      setAnswers((current) => {
        const next = current.map((answer) => [...answer]);
        next[tab] = next[tab].includes(label) ? next[tab].filter((item) => item !== label) : [...next[tab], label];
        return next;
      });
      return;
    }
    const next = answers.map((answer) => [...answer]);
    next[tab] = [label];
    setAnswers(next);
    if (model.autoSubmitSingleChoice) {
      void submit(next);
      return;
    }
    if (request.questions.length > 1) setTab(Math.min(tab + 1, request.questions.length));
  }

  function setCustomAnswer(value: string) {
    const previous = custom[tab];
    const nextCustom = [...custom];
    nextCustom[tab] = value;
    setCustom(nextCustom);
    const nextAnswers = answers.map((answer) => answer.filter((item) => item !== previous.trim()));
    if (value.trim()) {
      if (question?.multiple) nextAnswers[tab] = [...nextAnswers[tab], value.trim()];
      else nextAnswers[tab] = [value.trim()];
    }
    setAnswers(nextAnswers);
  }

  return (
    <View testID={`question-request-${request.id}`} style={styles.card}>
      {model.tabs.length > 1 ? (
        <View style={styles.tabs}>
          {model.tabs.map((item, index) => {
            const active = tab === index;
            const answered = index < answers.length && answers[index].length > 0;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="tab"
                testID={`question-tab-${item.header}`}
                style={[styles.tab, active && styles.tabActive]}
                onPress={() => setTab(index)}>
                <Text style={[styles.tabText, active && styles.tabTextActive, answered && !active && styles.tabTextAnswered]}>
                  {item.header}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {confirm ? (
        <View style={styles.questionBody}>
          <Text style={styles.questionText}>Review</Text>
          {request.questions.map((item, index) => (
            <Text key={item.header} selectable style={styles.reviewLine}>
              <Text style={styles.reviewHeader}>{item.header}: </Text>
              {answers[index].length > 0 ? answers[index].join(', ') : '(not answered)'}
            </Text>
          ))}
        </View>
      ) : question ? (
        <View style={styles.questionBody}>
          <Text selectable style={styles.questionText}>
            {question.question}
            {question.multiple ? ' (select all that apply)' : ''}
          </Text>
          {question.options.map((option, optionIndex) => {
            const selected = answers[tab].includes(option.label);
            return (
              <Pressable
                key={option.label}
                accessibilityRole={question.multiple ? 'checkbox' : 'radio'}
                testID={`question-option-${request.id}-${tab}-${option.label}`}
                style={[styles.option, selected && styles.optionSelected]}
                onPress={() => selectOption(option.label)}>
                <Text style={styles.optionNumber}>{optionIndex + 1}.</Text>
                <View style={styles.optionContent}>
                  <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
                    {question.multiple ? `[${selected ? 'x' : ' '}] ` : ''}
                    {option.label}
                  </Text>
                  {option.description ? (
                    <Text selectable style={styles.optionDescription}>
                      {option.description}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
          {question.custom !== false ? (
            <TextInput
              value={custom[tab]}
              onChangeText={setCustomAnswer}
              placeholder="Type your own answer"
              testID={`question-custom-${request.id}-${tab}`}
              style={styles.customInput}
              multiline
            />
          ) : null}
        </View>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          testID={`question-reject-${request.id}`}
          disabled={submitting || !onReject}
          style={[styles.secondaryButton, (submitting || !onReject) && styles.disabledButton]}
          onPress={reject}>
          <Text style={styles.secondaryButtonText}>Reject</Text>
        </Pressable>
        {confirm || (question?.multiple ?? false) || question?.custom !== false ? (
          <Pressable
            accessibilityRole="button"
            testID={
              confirm || question?.options.length === 0 || request.questions.length === 1
                ? `question-submit-${request.id}`
                : `question-next-${request.id}`
            }
            disabled={submitting}
            style={[styles.primaryButton, submitting && styles.disabledButton]}
            onPress={async () => {
              if (confirm || question?.options.length === 0 || request.questions.length === 1) {
                await submit();
                return;
              }
              setTab(Math.min(tab + 1, request.questions.length));
            }}>
            <Text style={styles.primaryButtonText}>
              {confirm || question?.options.length === 0 || request.questions.length === 1 ? 'Submit answers' : 'Next'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {requestError ? (
        <Text selectable testID={`question-request-error-${request.id}`} style={styles.errorText}>
          {requestError}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderLeftWidth: 2,
    borderLeftColor: palette.accent,
    backgroundColor: palette.panel,
  },
  tabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    paddingHorizontal: 10,
    paddingTop: 10,
  },
  tab: {
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  tabActive: {
    backgroundColor: palette.accent,
  },
  tabText: {
    color: palette.textMuted,
  },
  tabTextActive: {
    color: palette.foregroundOnAccent,
  },
  tabTextAnswered: {
    color: palette.text,
  },
  questionBody: {
    gap: 8,
    padding: 12,
  },
  questionText: {
    color: palette.text,
    fontSize: 15,
    lineHeight: 21,
  },
  option: {
    flexDirection: 'row',
    gap: 8,
    padding: 7,
  },
  optionSelected: {
    backgroundColor: palette.backgroundElement,
  },
  optionNumber: {
    color: palette.textMuted,
  },
  optionContent: {
    flex: 1,
    gap: 2,
  },
  optionLabel: {
    color: palette.text,
  },
  optionLabelSelected: {
    color: palette.success,
  },
  optionDescription: {
    color: palette.textMuted,
    fontSize: 13,
  },
  customInput: {
    minHeight: 38,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: palette.borderSubtle,
    color: palette.text,
    backgroundColor: palette.backgroundElement,
  },
  reviewLine: {
    color: palette.text,
  },
  reviewHeader: {
    color: palette.textMuted,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  secondaryButton: {
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  secondaryButtonText: {
    color: palette.textMuted,
  },
  primaryButton: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: palette.accent,
  },
  primaryButtonText: {
    fontWeight: '700',
    color: palette.foregroundOnAccent,
  },
  disabledButton: {
    opacity: 0.45,
  },
  errorText: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    color: palette.error,
  },
});
