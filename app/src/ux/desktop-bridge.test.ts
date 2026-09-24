import { describe, expect, it, vi } from 'vitest';

import {
  createDesktopActionBridge,
  detectDesktopShellHost,
  type DesktopShellHost,
} from './desktop-bridge';

function fakeHost() {
  let handler: ((payload: { action: string; context?: string }) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    handler = null;
  });
  const host: DesktopShellHost = {
    setContext: vi.fn(),
    onAction: vi.fn((next) => {
      handler = next;
      return unsubscribe;
    }),
  };
  return {
    host,
    unsubscribe,
    emit(action: string, context?: string) {
      handler?.({ action, context });
    },
  };
}

describe('desktop action bridge', () => {
  it('is inert on a device with no shell, instead of forcing a platform branch at every call site', () => {
    const dispatch = vi.fn();
    const bridge = createDesktopActionBridge({ host: null, dispatch });

    expect(bridge.available).toBe(false);
    expect(() => bridge.setContext('input')).not.toThrow();
    expect(() => bridge.dispose()).not.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('hands the app its own action, not the shell-side name', () => {
    const { host, emit } = fakeHost();
    const dispatch = vi.fn();
    createDesktopActionBridge({ host, dispatch });

    emit('session_compact');

    expect(dispatch).toHaveBeenCalledWith(
      { kind: 'command', id: 'compact' },
      { action: 'session_compact', context: undefined },
    );
  });

  it('still reports an action the app cannot perform, so the key can explain itself', () => {
    const { host, emit } = fakeHost();
    const dispatch = vi.fn();
    createDesktopActionBridge({ host, dispatch });

    emit('which_key_toggle', 'global');

    expect(dispatch).toHaveBeenCalledWith(
      { kind: 'unsupported', action: 'which_key_toggle' },
      { action: 'which_key_toggle', context: 'global' },
    );
  });

  it('survives a handler that throws, rather than leaving every later key dead', () => {
    const { host, emit } = fakeHost();
    const onError = vi.fn();
    const dispatch = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('handler exploded');
      })
      .mockImplementationOnce(() => undefined);
    createDesktopActionBridge({ host, dispatch, onError });

    emit('session_share');
    emit('session_compact');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('handler exploded');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('stops delivering once disposed', () => {
    const { host, unsubscribe, emit } = fakeHost();
    const dispatch = vi.fn();
    const bridge = createDesktopActionBridge({ host, dispatch });

    bridge.dispose();
    emit('session_share');

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(() => bridge.setContext('input')).not.toThrow();
    expect(host.setContext).not.toHaveBeenCalled();
  });

  it('forwards the focused surface so one key can mean two things', () => {
    const { host } = fakeHost();
    const bridge = createDesktopActionBridge({ host, dispatch: vi.fn() });

    bridge.setContext('dialog:select');

    expect(host.setContext).toHaveBeenCalledWith('dialog:select');
  });

  it('only accepts a host that exposes the whole contract', () => {
    expect(detectDesktopShellHost({})).toBeNull();
    expect(detectDesktopShellHost({ cockpit: {} })).toBeNull();
    expect(detectDesktopShellHost({ cockpit: { onAction() {} } })).toBeNull();

    const complete = { onAction() { return () => {}; }, setContext() {} };
    expect(detectDesktopShellHost({ cockpit: complete })).toBe(complete);
  });
});
