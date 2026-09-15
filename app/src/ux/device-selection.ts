/**
 * The first screen's model: which host, and which backend on it.
 *
 * A host may run several backends side by side, one per profile, and the relay
 * exposes each as its own target. The client calls a target a "machine", which
 * is the word the rest of the UI already uses.
 *
 * One thing has to be said on this screen rather than discovered later: every
 * machine on a host shares one session database, so the same session appears
 * under each of them. Choosing a machine chooses which process will run the next
 * prompt, not which sessions exist.
 */

import type { HostConnection, RelayTargetState } from '../opencode/types';

export interface DeviceChoice {
  hostId: string;
  hostName: string;
  targetId: string;
  targetName: string;
  reachable: boolean;
  lastChecked: string | null;
  /** Why this cannot be chosen, when it cannot. */
  blockedReason?: string;
}

export interface DeviceGroup {
  hostId: string;
  hostName: string;
  hostReachable: boolean;
  /** True when this host runs more than one backend, which is when the shared
   *  session database needs explaining. */
  sharesSessionsAcrossMachines: boolean;
  choices: DeviceChoice[];
}

export interface DeviceSelectionModel {
  groups: DeviceGroup[];
  totalChoices: number;
  reachableChoices: number;
  emptyReason?: string;
}

export function buildDeviceSelectionModel(input: {
  connections: readonly HostConnection[];
  relayTargets: Readonly<Record<string, RelayTargetState[]>>;
}): DeviceSelectionModel {
  const groups: DeviceGroup[] = input.connections.map((connection) => {
    const targets = input.relayTargets[connection.id] ?? [];

    // A relay that has not been reached yet reports no targets. Showing the host
    // with an explanation beats hiding it, because hiding looks like the host
    // was never added.
    const choices: DeviceChoice[] = targets.length === 0
      ? [{
          hostId: connection.id,
          hostName: connection.name,
          targetId: '',
          targetName: connection.isReachable ? 'No machine authorized' : 'Not reached yet',
          reachable: false,
          lastChecked: connection.lastConnected,
          blockedReason: connection.isReachable
            ? 'This relay authorized no machine for this device'
            : 'Host has not answered yet',
        }]
      : targets.map((target) => ({
          hostId: connection.id,
          hostName: connection.name,
          targetId: target.id,
          targetName: target.name,
          reachable: target.reachable,
          lastChecked: target.lastChecked,
          blockedReason: target.reachable ? undefined : target.error ?? 'Machine is not answering',
        }));

    return {
      hostId: connection.id,
      hostName: connection.name,
      hostReachable: connection.isReachable,
      sharesSessionsAcrossMachines: targets.length > 1,
      choices,
    };
  });

  const totalChoices = groups.reduce((sum, group) => sum + group.choices.filter((choice) => choice.targetId).length, 0);
  const reachableChoices = groups.reduce(
    (sum, group) => sum + group.choices.filter((choice) => choice.targetId && choice.reachable).length,
    0,
  );

  return {
    groups,
    totalChoices,
    reachableChoices,
    emptyReason: input.connections.length === 0
      ? 'No host is paired yet'
      : totalChoices === 0
        ? 'No machine is available on any paired host'
        : undefined,
  };
}

export function isDeviceChoiceSelectable(choice: DeviceChoice): boolean {
  return Boolean(choice.targetId) && choice.reachable;
}

/** The one machine to open without asking, when there is no real choice to make. */
export function soleSelectableChoice(model: DeviceSelectionModel): DeviceChoice | null {
  const selectable = model.groups.flatMap((group) => group.choices).filter(isDeviceChoiceSelectable);
  return selectable.length === 1 ? selectable[0] : null;
}
