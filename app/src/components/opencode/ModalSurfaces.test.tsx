import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptPasteModal } from './PromptPasteModal';
import { TextViewModal } from './TextViewModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ writeClipboardText: vi.fn() }));

vi.mock('@/src/ux/clipboard', () => ({ writeClipboardText: mocks.writeClipboardText }));

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) =>
    React.forwardRef<unknown, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      React.createElement(name, { ...props, ref } as any, children as any),
    );
  return {
    Modal: host('Modal'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
    Text: host('Text'),
    TextInput: host('TextInput'),
    Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default },
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    View: host('View'),
  };
});

describe('native modal surfaces', () => {
  beforeEach(() => mocks.writeClipboardText.mockReset());

  it('keeps the manual paste sheet out of the dismiss scrim, which still closes it', async () => {
    const onClose = vi.fn();
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(
        <PromptPasteModal visible value="" onChangeText={() => undefined} onInsert={() => undefined} onClose={onClose} />,
      );
    });
    const stopPropagation = vi.fn();

    // The sheet is a sibling of the scrim, not its child, so a click on the sheet
    // (in a desktop window, a click on its text field) cannot reach the scrim.
    const scrim = screen!.root.findByProps({ testID: 'manual-paste-sheet-scrim' });
    expect(scrim.findAll((node) => node.props.testID === 'manual-paste-input')).toHaveLength(0);
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    scrim.props.onPress();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen!.root.findByProps({ testID: 'manual-paste-insert' }).props.disabled).toBe(true);
  });

  it('keeps a text-view copy failure inline without closing the viewer', async () => {
    mocks.writeClipboardText.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    const onClose = vi.fn();
    let screen: ReactTestRenderer | undefined;
    await act(async () => {
      screen = create(<TextViewModal title="Output" text="hello" visible onClose={onClose} />);
    });
    await act(async () => {
      await screen!.root.findByProps({ testID: 'text-view-copy-raw' }).props.onPress();
    });

    expect(screen!.root.findByProps({ testID: 'text-view-copy-error' }).props.children).toBe('Clipboard unavailable');
    expect(onClose).not.toHaveBeenCalled();
  });
});
