import { describe, expect, it, vi } from 'vitest';

import { LiveSessionRegistry } from './live-session-registry';

describe('LiveSessionRegistry', () => {
  it('refuses to create more than five live sessions before invoking the factory', async () => {
    const registry = new LiveSessionRegistry(5);
    for (let index = 1; index <= 5; index += 1) registry.register(`s${index}`);
    const factory = vi.fn(async () => ({ id: 's6' }));

    await expect(registry.create(factory)).rejects.toThrow('session cap exceeded (5)');
    expect(factory).not.toHaveBeenCalled();
  });

  it('cleans sessions in reverse creation order and reports every cleanup failure', async () => {
    const registry = new LiveSessionRegistry(5);
    registry.register('parent');
    registry.register('child');
    const order: string[] = [];

    await expect(
      registry.cleanup(async (sessionId) => {
        order.push(sessionId);
        if (sessionId === 'child') throw new Error('readback returned 200');
      }),
    ).rejects.toThrow('child: readback returned 200');
    expect(order).toEqual(['child', 'parent']);
    expect(registry.size).toBe(0);
  });
});
