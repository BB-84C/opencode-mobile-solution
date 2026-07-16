import { describe, expect, it } from 'vitest';

import { createInterruptControlModel, interruptArmWindowMs } from './interrupt-control';

describe('interrupt control UX', () => {
  it('starts as an armed interrupt affordance instead of a destructive confirmation', () => {
    expect(createInterruptControlModel({ armedAt: null, now: 10_000 })).toEqual({
      armed: false,
      label: 'Interrupt',
      accessibilityLabel: 'Arm interrupt',
    });
  });

  it('shows esc-again equivalent confirmation copy while armed', () => {
    expect(createInterruptControlModel({ armedAt: 10_000, now: 10_500 })).toEqual({
      armed: true,
      label: 'Tap again to interrupt',
      accessibilityLabel: 'Tap again to interrupt the running session',
    });
  });

  it('expires the confirmation state after the interrupt window', () => {
    expect(createInterruptControlModel({ armedAt: 10_000, now: 10_000 + interruptArmWindowMs + 1 })).toMatchObject({
      armed: false,
      label: 'Interrupt',
    });
  });
});
