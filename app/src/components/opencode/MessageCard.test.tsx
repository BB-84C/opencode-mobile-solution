import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageWithParts } from '@/src/opencode/types';

import { MessageCard } from './MessageCard';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  markdownRenders: vi.fn(),
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) =>
    React.forwardRef<unknown, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      React.createElement(name, { ...props, ref } as any, children as any),
    );
  return {
    Pressable: host('Pressable'),
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T) => styles,
      hairlineWidth: 1,
    },
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
  };
});

vi.mock('@/src/store/mobile-store', () => ({
  partToText: (part: { text?: unknown }) => String(part.text ?? ''),
}));

vi.mock('@/src/ux/clipboard', () => ({ writeClipboardText: vi.fn() }));

vi.mock('./ActionModal', async () => {
  const React = await import('react');
  return { ActionModal: (props: Record<string, unknown>) => React.createElement('ActionModal', props) };
});

vi.mock('./TextViewModal', async () => {
  const React = await import('react');
  return { TextViewModal: (props: Record<string, unknown>) => React.createElement('TextViewModal', props) };
});

vi.mock('./MarkdownText', async () => {
  const React = await import('react');
  return {
    MarkdownText: ({ children, ...props }: { children: string }) => {
      mocks.markdownRenders(children);
      return React.createElement('MarkdownText', props, children);
    },
  };
});

const message = {
  info: { id: 'message-1', sessionID: 'session-1', role: 'user' },
  parts: [{ id: 'part-1', messageID: 'message-1', sessionID: 'session-1', type: 'text', text: 'hello' }],
} as MessageWithParts;

describe('MessageCard rendering boundary', () => {
  beforeEach(() => mocks.markdownRenders.mockReset());

  it('does not rebuild unchanged content for new callback identities and still invokes the latest callback', async () => {
    const firstTimeline = vi.fn();
    const latestTimeline = vi.fn();
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(<MessageCard message={message} onTimeline={firstTimeline} />);
    });
    expect(mocks.markdownRenders).toHaveBeenCalledTimes(1);

    await act(async () => {
      screen!.update(<MessageCard message={message} onTimeline={latestTimeline} />);
    });
    expect(mocks.markdownRenders).toHaveBeenCalledTimes(1);

    await act(async () => {
      screen!.root.findByProps({ testID: 'message-card-message-1' }).props.onPress();
    });
    const actionModal = screen!.root.findByType('ActionModal' as any);
    const timeline = actionModal.props.items.find((item: { id: string }) => item.id === 'timeline');
    await act(async () => {
      await timeline.onPress();
    });
    expect(firstTimeline).not.toHaveBeenCalled();
    expect(latestTimeline).toHaveBeenCalledWith('message-1');
  });

  it('rebuilds the card when the immutable message value changes', async () => {
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(<MessageCard message={message} />);
    });
    expect(mocks.markdownRenders).toHaveBeenCalledTimes(1);

    const updated = {
      ...message,
      parts: [{ ...message.parts[0], text: 'updated' }],
    } as MessageWithParts;
    await act(async () => {
      screen!.update(<MessageCard message={updated} />);
    });
    expect(mocks.markdownRenders).toHaveBeenCalledTimes(2);
  });

  it('rebuilds only the changed immutable part inside a streaming message', async () => {
    const stablePart = { ...message.parts[0], id: 'stable-part', text: 'stable' };
    const streamingPart = { ...message.parts[0], id: 'streaming-part', text: 'streaming' };
    const multiPartMessage = { ...message, parts: [stablePart, streamingPart] } as MessageWithParts;
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(<MessageCard message={multiPartMessage} />);
    });
    expect(mocks.markdownRenders.mock.calls.map(([text]) => text)).toEqual(['stable', 'streaming']);

    await act(async () => {
      screen!.update(
        <MessageCard
          message={{
            ...multiPartMessage,
            parts: [stablePart, { ...streamingPart, text: 'streaming update' }],
          }}
        />,
      );
    });
    expect(mocks.markdownRenders.mock.calls.map(([text]) => text)).toEqual([
      'stable',
      'streaming',
      'streaming update',
    ]);
  });

  it('renders the complete shell command with an official TUI-style expandable output preview', async () => {
    const output = Array.from({ length: 11 }, (_, index) => `line-${index + 1}`).join('\n');
    const shellMessage = {
      info: { id: 'shell-message', sessionID: 'session-1', role: 'assistant' },
      parts: [{
        id: 'shell-part',
        messageID: 'shell-message',
        sessionID: 'session-1',
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'printf all-output' }, metadata: { output } },
      }],
    } as MessageWithParts;
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(<MessageCard message={shellMessage} showActions={false} />);
    });

    expect(screen!.root.findByProps({ testID: 'tool-command-shell-message-0' }).props.children).toBe('$ printf all-output');
    expect(screen!.root.findByProps({ testID: 'tool-output-shell-message-0' }).props.children).toBe(
      `${Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join('\n')}\n…`,
    );
    expect(screen!.root.findByProps({ testID: 'tool-output-toggle-label-shell-message-0' }).props.children).toBe('Click to expand');

    await act(async () => screen!.root.findByProps({ testID: 'tool-output-toggle-shell-message-0' }).props.onPress());
    expect(screen!.root.findByProps({ testID: 'tool-output-shell-message-0' }).props.children).toBe(output);
    expect(screen!.root.findByProps({ testID: 'tool-output-toggle-label-shell-message-0' }).props.children).toBe('Click to collapse');
  });
});
