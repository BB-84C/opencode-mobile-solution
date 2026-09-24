import { describe, expect, it, vi } from 'vitest';

import { createScreenActionRegistry } from './desktop-screen-registry';

describe('screen action registry', () => {
  it('runs the handler the mounted screen claimed', () => {
    const registry = createScreenActionRegistry();
    const scroll = vi.fn();
    registry.register('scroll-page-up', scroll);

    expect(registry.invoke('scroll-page-up')).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('reports that nobody claimed an action rather than pretending it ran', () => {
    const registry = createScreenActionRegistry();

    expect(registry.invoke('scroll-page-up')).toBe(false);
  });

  it('stops reaching a screen that has gone away', () => {
    const registry = createScreenActionRegistry();
    const scroll = vi.fn();
    const dispose = registry.register('scroll-page-up', scroll);

    dispose();

    // A key pressed after navigating away must not reach a component that is no
    // longer mounted; it should look unclaimed instead.
    expect(registry.invoke('scroll-page-up')).toBe(false);
    expect(registry.claimed().has('scroll-page-up')).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
  });

  it('lets the newer screen take over, and its dispose does not revive the older one', () => {
    const registry = createScreenActionRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = registry.register('scroll-page-up', first);
    registry.register('scroll-page-up', second);

    // Navigating between two sessions mounts the second before the first has
    // unmounted, so the stale dispose must not remove the live handler.
    disposeFirst();

    expect(registry.invoke('scroll-page-up')).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('registers and releases a screen\'s whole set at once', () => {
    const registry = createScreenActionRegistry();
    const handlers = { 'scroll-page-up': vi.fn(), 'scroll-page-down': vi.fn() };
    const dispose = registry.registerAll(handlers);

    expect([...registry.claimed()].sort()).toEqual(['scroll-page-down', 'scroll-page-up']);

    dispose();

    expect([...registry.claimed()]).toEqual([]);
  });

  it('refuses a handler that is not callable, at registration rather than at key press', () => {
    const registry = createScreenActionRegistry();

    expect(() => registry.register('scroll-page-up', undefined as never)).toThrow(/must be a function/);
  });
});
