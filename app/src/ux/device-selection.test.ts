import { describe, expect, it } from 'vitest';

import {
  buildDeviceSelectionModel,
  isDeviceChoiceSelectable,
  soleSelectableChoice,
} from './device-selection';
import type { HostConnection, RelayTargetState } from '../opencode/types';

const host = (over: Partial<HostConnection> = {}): HostConnection => ({
  id: 'office',
  name: 'Office Mac',
  url: 'https://host.example.ts.net:8443',
  authType: 'bearer',
  lastConnected: '2026-09-16T00:00:00.000Z',
  isReachable: true,
  ...over,
});

const target = (over: Partial<RelayTargetState> = {}): RelayTargetState => ({
  id: 'default',
  name: 'default',
  reachable: true,
  lastChecked: '2026-09-16T00:00:00.000Z',
  ...over,
});

describe('device selection model', () => {
  it('says nothing is paired rather than showing an empty screen', () => {
    const model = buildDeviceSelectionModel({ connections: [], relayTargets: {} });

    expect(model.groups).toEqual([]);
    expect(model.emptyReason).toBe('No host is paired yet');
  });

  it('offers one entry per machine on a host', () => {
    const model = buildDeviceSelectionModel({
      connections: [host()],
      relayTargets: { office: [target(), target({ id: 'gpt', name: 'gpt' })] },
    });

    expect(model.groups[0].choices.map((choice) => choice.targetId)).toEqual(['default', 'gpt']);
    expect(model.totalChoices).toBe(2);
    expect(model.reachableChoices).toBe(2);
  });

  it('flags a host that runs several machines, because they share one session database', () => {
    // The same session appears under every machine on a host. Choosing one picks
    // which process runs the next prompt, not which sessions exist, and that has
    // to be said on this screen rather than discovered later.
    const several = buildDeviceSelectionModel({
      connections: [host()],
      relayTargets: { office: [target(), target({ id: 'gpt', name: 'gpt' })] },
    });
    const single = buildDeviceSelectionModel({
      connections: [host()],
      relayTargets: { office: [target()] },
    });

    expect(several.groups[0].sharesSessionsAcrossMachines).toBe(true);
    expect(single.groups[0].sharesSessionsAcrossMachines).toBe(false);
  });

  it('keeps a host with no machine visible, and says which kind of nothing it is', () => {
    // Hiding it would look like the host was never added.
    const answered = buildDeviceSelectionModel({
      connections: [host({ isReachable: true })],
      relayTargets: { office: [] },
    });
    const silent = buildDeviceSelectionModel({
      connections: [host({ isReachable: false })],
      relayTargets: {},
    });

    expect(answered.groups[0].choices[0].blockedReason).toBe('This relay authorized no machine for this device');
    expect(silent.groups[0].choices[0].blockedReason).toBe('Host has not answered yet');
    expect(answered.totalChoices).toBe(0);
  });

  it('carries the reason a machine is not answering', () => {
    const model = buildDeviceSelectionModel({
      connections: [host()],
      relayTargets: { office: [target({ reachable: false, error: 'upstream refused the connection' })] },
    });

    expect(model.groups[0].choices[0].blockedReason).toBe('upstream refused the connection');
    expect(model.reachableChoices).toBe(0);
  });

  it('falls back to a generic reason when the probe recorded none', () => {
    const model = buildDeviceSelectionModel({
      connections: [host()],
      relayTargets: { office: [target({ reachable: false })] },
    });

    expect(model.groups[0].choices[0].blockedReason).toBe('Machine is not answering');
  });

  it('refuses to select a placeholder or an unreachable machine', () => {
    const model = buildDeviceSelectionModel({
      connections: [host()],
      relayTargets: { office: [target({ reachable: false }), target({ id: 'gpt', name: 'gpt' })] },
    });
    const [unreachable, reachable] = model.groups[0].choices;

    expect(isDeviceChoiceSelectable(unreachable)).toBe(false);
    expect(isDeviceChoiceSelectable(reachable)).toBe(true);
    expect(isDeviceChoiceSelectable({ ...reachable, targetId: '' })).toBe(false);
  });

  it('identifies the single machine worth opening without asking', () => {
    const one = buildDeviceSelectionModel({
      connections: [host()],
      relayTargets: { office: [target()] },
    });
    const two = buildDeviceSelectionModel({
      connections: [host()],
      relayTargets: { office: [target(), target({ id: 'gpt', name: 'gpt' })] },
    });
    const none = buildDeviceSelectionModel({
      connections: [host()],
      relayTargets: { office: [target({ reachable: false })] },
    });

    expect(soleSelectableChoice(one)?.targetId).toBe('default');
    expect(soleSelectableChoice(two)).toBeNull();
    expect(soleSelectableChoice(none)).toBeNull();
  });

  it('groups machines under the host they belong to across several hosts', () => {
    const model = buildDeviceSelectionModel({
      connections: [host(), host({ id: 'laptop', name: 'Laptop' })],
      relayTargets: {
        office: [target(), target({ id: 'gpt', name: 'gpt' })],
        laptop: [target({ id: 'local', name: 'local' })],
      },
    });

    expect(model.groups.map((group) => group.hostId)).toEqual(['office', 'laptop']);
    expect(model.totalChoices).toBe(3);
    expect(model.groups[1].sharesSessionsAcrossMachines).toBe(false);
  });
});
