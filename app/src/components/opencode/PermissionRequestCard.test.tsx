import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { PermissionRequestCard } from './PermissionRequestCard';

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

const request = { id: 'per_gate', sessionID: 'ses_1', permission: 'external_directory', patterns: ['/etc/*'], metadata: { command: 'cat /etc/hosts' }, always: ['/etc/*'] };

describe('PermissionRequestCard', () => {
  it('displays the real command and scope, blocks double submission, and keeps failures recoverable', async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    const onReply = vi.fn(() => pending);
    let screen!: ReactTestRenderer;
    await act(async () => { screen = create(<PermissionRequestCard request={request} onReply={onReply} />); });
    expect(JSON.stringify(screen.toJSON())).toContain('cat /etc/hosts');
    expect(JSON.stringify(screen.toJSON())).toContain('/etc/*');
    expect(onReply).not.toHaveBeenCalled();
    const button = () => screen.root.findByProps({ testID: 'permission-request-per_gate-reject' });
    await act(async () => { screen.root.findByProps({ testID: 'permission-request-per_gate-guidance' }).props.onChangeText('Stay inside'); });
    let submission!: Promise<void>;
    await act(async () => {
      const press = button().props.onPress;
      submission = press();
      await press();
    });
    expect(onReply).toHaveBeenCalledExactlyOnceWith('per_gate', 'reject', 'Stay inside');
    expect(button().props.disabled).toBe(true);
    await act(async () => { reject(new Error('Connection lost')); await submission; });
    expect(screen.root.findByProps({ testID: 'permission-request-per_gate-error' }).props.children).toBe('Connection lost');
    expect(button().props.disabled).toBe(false);
    await act(async () => screen.unmount());
  });
});
