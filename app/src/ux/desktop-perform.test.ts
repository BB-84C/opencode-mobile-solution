import { describe, expect, it, vi } from 'vitest';

import { performDesktopAction } from './desktop-perform';
import { createScreenActionRegistry } from './desktop-screen-registry';

const noRegistry = { invoke: () => false };

describe('performing a routed keyboard action', () => {
  it('calls the store action the routing chose', () => {
    const interrupt = vi.fn();
    const report = vi.fn();

    const result = performDesktopAction({
      outcome: { kind: 'store', action: 'interrupt' },
      store: { interrupt },
      registry: noRegistry,
      report,
    });

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ performed: 'store', action: 'interrupt' });
    expect(report).not.toHaveBeenCalled();
  });

  it('runs the handler a mounted screen claimed', () => {
    const registry = createScreenActionRegistry();
    const scroll = vi.fn();
    registry.register('scroll-page-up', scroll);

    const result = performDesktopAction({
      outcome: { kind: 'screen', action: 'scroll-page-up' },
      store: {},
      registry,
      report: vi.fn(),
    });

    expect(scroll).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ performed: 'screen', action: 'scroll-page-up' });
  });

  it('says why nothing happened instead of leaving a dead key', () => {
    const report = vi.fn();

    performDesktopAction({
      outcome: { kind: 'report', action: 'interrupt', reason: 'no-session' },
      store: {},
      registry: noRegistry,
      report,
    });
    performDesktopAction({
      outcome: { kind: 'report', action: 'which_key_toggle', reason: 'unsupported' },
      store: {},
      registry: noRegistry,
      report,
    });

    expect(report.mock.calls.map((call) => call[0])).toEqual([
      'interrupt needs an open session',
      'which_key_toggle has no desktop equivalent yet',
    ]);
  });

  it('reports when the screen let go between routing and performing', () => {
    const report = vi.fn();

    // Ordinary during navigation: routing saw the handler, the screen unmounted
    // before the key was acted on.
    const result = performDesktopAction({
      outcome: { kind: 'screen', action: 'scroll-page-up' },
      store: {},
      registry: noRegistry,
      report,
    });

    expect(result).toEqual({
      performed: 'reported',
      action: 'scroll-page-up',
      message: 'scroll-page-up is not wired up yet',
    });
    expect(report).toHaveBeenCalledWith('scroll-page-up is not wired up yet');
  });

  it('reports a store action this build does not provide', () => {
    const report = vi.fn();

    const result = performDesktopAction({
      outcome: { kind: 'store', action: 'fork' },
      store: {},
      registry: noRegistry,
      report,
    });

    expect(result.performed).toBe('reported');
    expect(report).toHaveBeenCalledWith('fork is not wired up yet');
  });

  it('surfaces a rejected store action instead of leaving an unhandled rejection', async () => {
    const onError = vi.fn();

    performDesktopAction({
      outcome: { kind: 'store', action: 'compact' },
      store: { compact: () => Promise.reject(new Error('backend said no')) },
      registry: noRegistry,
      report: vi.fn(),
      onError,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('backend said no');
  });

  it('surfaces a store action that throws synchronously', () => {
    const onError = vi.fn();

    performDesktopAction({
      outcome: { kind: 'store', action: 'cycle-agent' },
      store: { 'cycle-agent': () => { throw new Error('no agents loaded'); } },
      registry: noRegistry,
      report: vi.fn(),
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('no agents loaded');
  });
});
