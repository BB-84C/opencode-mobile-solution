import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  currentDesktopContext,
  installDesktopContextSink,
  resetDesktopContext,
  setDesktopContext,
} from './desktop-context';

afterEach(() => resetDesktopContext());

describe('desktop context', () => {
  it('starts on the surface that has no keys of its own', () => {
    expect(currentDesktopContext()).toBe('global');
  });

  it('tells the shell which surface the user moved to', () => {
    const sink = vi.fn();
    installDesktopContextSink(sink);
    sink.mockClear();

    setDesktopContext('messages');

    expect(sink).toHaveBeenCalledWith('messages');
    expect(currentDesktopContext()).toBe('messages');
  });

  it('replays the current surface to a sink that arrives late', () => {
    // The screen can mount before the shell bridge does. Without the replay the
    // shell would spend the first keystrokes believing the user is on 'global',
    // which is exactly where the transcript keys do not resolve.
    setDesktopContext('messages');
    const sink = vi.fn();

    installDesktopContextSink(sink);

    expect(sink).toHaveBeenCalledWith('messages');
  });

  it('does not repeat itself when nothing changed', () => {
    const sink = vi.fn();
    installDesktopContextSink(sink);
    sink.mockClear();

    setDesktopContext('input');
    setDesktopContext('input');

    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('stops delivering once the bridge is gone', () => {
    const sink = vi.fn();
    const uninstall = installDesktopContextSink(sink);
    uninstall();
    sink.mockClear();

    setDesktopContext('diff');

    expect(sink).not.toHaveBeenCalled();
    // The value is still tracked, so the next bridge gets the truth.
    expect(currentDesktopContext()).toBe('diff');
  });

  it('a stale uninstall does not silence the sink that replaced it', () => {
    const first = vi.fn();
    const second = vi.fn();
    const uninstallFirst = installDesktopContextSink(first);
    installDesktopContextSink(second);
    // The install-time replay already called both; this is about what follows.
    first.mockClear();
    second.mockClear();

    uninstallFirst();
    setDesktopContext('messages');

    expect(second).toHaveBeenCalledWith('messages');
    expect(first).not.toHaveBeenCalled();
  });

  it('setting a context with no bridge attached does not throw', () => {
    expect(() => setDesktopContext('messages')).not.toThrow();
    expect(currentDesktopContext()).toBe('messages');
  });
});
