import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { QuestionRequestCard } from './QuestionRequestCard';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) =>
    React.forwardRef<unknown, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      React.createElement(name, { ...props, ref } as any, children as any),
    );
  return {
    Pressable: host('Pressable'),
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
  };
});

const request = {
  id: 'q-network',
  sessionID: 'session-1',
  questions: [
    {
      header: 'Plan',
      question: 'Describe the plan',
      options: [],
      custom: true,
    },
  ],
};

describe('QuestionRequestCard failure UX', () => {
  it('keeps reply and reject failures inline and recoverable instead of throwing from a button', async () => {
    const onReply = vi.fn().mockRejectedValue(new Error('Reply unavailable'));
    const onReject = vi.fn().mockRejectedValue(new Error('Reject unavailable'));
    let screen: ReactTestRenderer | undefined;

    await act(async () => {
      screen = create(<QuestionRequestCard request={request} onReply={onReply} onReject={onReject} />);
    });
    await act(async () => {
      screen!.root.findByProps({ testID: 'question-custom-q-network-0' }).props.onChangeText('Use the safe plan');
    });
    await act(async () => {
      await screen!.root.findByProps({ testID: 'question-submit-q-network' }).props.onPress();
    });

    expect(screen!.root.findByProps({ testID: 'question-request-error-q-network' }).props.children).toBe('Reply unavailable');
    expect(screen!.root.findByProps({ testID: 'question-submit-q-network' }).props.disabled).toBe(false);

    await act(async () => {
      await screen!.root.findByProps({ testID: 'question-reject-q-network' }).props.onPress();
    });

    expect(screen!.root.findByProps({ testID: 'question-request-error-q-network' }).props.children).toBe('Reject unavailable');
    expect(screen!.root.findByProps({ testID: 'question-reject-q-network' }).props.disabled).toBe(false);
  });
});
