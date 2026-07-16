export const interruptArmWindowMs = 5_000;

export function createInterruptControlModel({
  armedAt,
  now,
}: {
  armedAt: number | null;
  now: number;
}) {
  const armed = armedAt !== null && now - armedAt <= interruptArmWindowMs;
  return {
    armed,
    label: armed ? 'Tap again to interrupt' : 'Interrupt',
    accessibilityLabel: armed ? 'Tap again to interrupt the running session' : 'Arm interrupt',
  };
}
