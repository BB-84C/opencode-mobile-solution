import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ActionModal } from './ActionModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) =>
    React.forwardRef<unknown, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      React.createElement(name, { ...props, ref } as any, children as any),
    );

  return {
    Modal: host('Modal'),
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T) => styles,
      hairlineWidth: 1,
    },
    Text: host('Text'),
    View: host('View'),
  };
});

describe('ActionModal', () => {
  it('dismisses the native modal before running an action that may open the next sheet', async () => {
    const sequence: string[] = [];
    let screen: ReactTestRenderer | undefined;

    await act(async () => {
      screen = create(
        <ActionModal
          title="Session"
          visible
          onClose={() => sequence.push('close')}
          items={[
            {
              id: 'commands',
              label: 'Commands',
              onPress: () => {
                sequence.push('action');
              },
            },
          ]}
        />,
      );
    });

    await act(async () => {
      await screen!.root.findByProps({ testID: 'action-commands' }).props.onPress();
    });

    expect(sequence).toEqual(['close']);

    await act(async () => {
      screen!.root.findByType('Modal' as any).props.onDismiss();
    });

    expect(sequence).toEqual(['close', 'action']);
  });

  it('never dismisses or invokes disabled rows', async () => {
    const onClose = vi.fn();
    const onPress = vi.fn();
    let screen: ReactTestRenderer | undefined;

    await act(async () => {
      screen = create(
        <ActionModal
          title="Disabled"
          visible
          onClose={onClose}
          items={[{ id: 'disabled', label: 'Unavailable', disabled: true, onPress }]}
        />,
      );
    });

    await act(async () => {
      await screen!.root.findByProps({ testID: 'action-disabled' }).props.onPress();
    });

    expect(onPress).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders informational rows without button semantics or a press handler', async () => {
    let screen: ReactTestRenderer | undefined;

    await act(async () => {
      screen = create(
        <ActionModal
          title="Details"
          visible
          onClose={() => undefined}
          items={[{ id: 'status', label: 'Status', detail: 'idle', interactive: false }]}
        />,
      );
    });

    const row = screen!.root.findByProps({ testID: 'action-status' });
    expect(row.props.accessibilityRole).toBeUndefined();
    expect(row.props.onPress).toBeUndefined();
  });

  it('reports rejected actions after dismissal instead of leaving an unhandled failure', async () => {
    const onActionError = vi.fn();
    let screen: ReactTestRenderer | undefined;

    await act(async () => {
      screen = create(
        <ActionModal
          title="Failure"
          visible
          onClose={() => undefined}
          onActionError={onActionError}
          items={[{ id: 'failing', label: 'Failing action', onPress: () => Promise.reject(new Error('Action failed')) }]}
        />,
      );
    });
    await act(async () => {
      screen!.root.findByProps({ testID: 'action-failing' }).props.onPress();
      screen!.root.findByType('Modal' as any).props.onDismiss();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onActionError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Action failed' }));
  });
});
