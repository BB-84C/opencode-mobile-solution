import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageWithParts } from '@/src/opencode/types';

import { MessageCard } from './MessageCard';
import { TranscriptContext } from './transcript-context';

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
    Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default },
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
      screen!.root.findByProps({ testID: 'message-actions-message-1' }).props.onPress();
    });
    const actionModal = screen!.root.findByType('ActionModal' as any);
    const timeline = actionModal.props.items.find((item: { id: string }) => item.id === 'timeline');
    await act(async () => {
      await timeline.onPress();
    });
    expect(firstTimeline).not.toHaveBeenCalled();
    expect(latestTimeline).toHaveBeenCalledWith('message-1');
  });

  it('opens Select text on the whole conversation, scrolled to this message', async () => {
    const reply = {
      info: { id: 'message-2', sessionID: 'session-1', role: 'assistant' },
      parts: [{ id: 'part-2', messageID: 'message-2', sessionID: 'session-1', type: 'text', text: 'world' }],
    } as MessageWithParts;
    const transcript = [message, reply];
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(
        <TranscriptContext.Provider value={() => transcript}>
          <MessageCard message={reply} />
        </TranscriptContext.Provider>,
      );
    });
    await act(async () => {
      screen!.root.findByProps({ testID: 'message-actions-message-2' }).props.onPress();
    });
    const actionModal = screen!.root.findByType('ActionModal' as any);
    const selectText = actionModal.props.items.find((item: { id: string }) => item.id === 'open-text-view');
    await act(async () => selectText.onPress());
    const sheet = screen!.root.findByType('TextViewModal' as any);
    expect(sheet.props.visible).toBe(true);
    expect(sheet.props.title).toBe('Conversation');
    expect(sheet.props.text).toBe('── You ──\nhello\n\n── Assistant ──\nworld');
    expect(sheet.props.text.slice(sheet.props.focusOffset)).toBe('── Assistant ──\nworld');
  });

  it('shows a failed turn in a red box, and an abort only as an interruption', async () => {
    const failed = {
      info: { id: 'm-err', sessionID: 'session-1', role: 'assistant', error: { name: 'APIError', data: { message: 'No available Claude accounts', statusCode: 500 } } },
      parts: [],
    } as unknown as MessageWithParts;
    let screen: ReactTestRenderer | undefined;
    await act(async () => { screen = create(<MessageCard message={failed} />); });
    expect(screen!.root.findAll((node) => node.props.testID === 'message-turn-error-m-err' && node.props.accessibilityRole === 'alert').length).toBeGreaterThan(0);
    const texts = screen!.root.findAllByType('Text' as any).map((node) => String(node.props.children));
    expect(texts).toContain('API error · 500');
    expect(texts).toContain('No available Claude accounts');

    const aborted = { ...failed, info: { ...failed.info, id: 'm-abort', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } } as unknown as MessageWithParts;
    await act(async () => { screen!.update(<MessageCard message={aborted} />); });
    const texts2 = screen!.root.findAllByType('Text' as any).map((node) => String(node.props.children));
    expect(texts2).toContain('Interrupted');
    expect(texts2).not.toContain('No available Claude accounts');
  });

  it('labels an attached file by name, without printing its bytes', async () => {
    const withFile = {
      info: { id: 'message-2', sessionID: 'session-1', role: 'user' },
      parts: [
        { id: 'part-1', messageID: 'message-2', sessionID: 'session-1', type: 'text', text: 'look' },
        { id: 'part-2', messageID: 'message-2', sessionID: 'session-1', type: 'file', mime: 'image/jpeg', filename: 'shot.jpg', url: 'data:image/jpeg;base64,SECRETBYTES' },
      ],
    } as MessageWithParts;
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(<MessageCard message={withFile} />);
    });

    const label = screen!.root.findByProps({ testID: 'message-file-message-2-1' });
    expect(JSON.stringify(label.props.children)).toContain('shot.jpg');
    expect(JSON.stringify(screen!.toJSON())).not.toContain('SECRETBYTES');
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
