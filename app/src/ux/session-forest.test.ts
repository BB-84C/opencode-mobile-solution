import { describe, expect, it } from 'vitest';

import {
  buildSessionForest,
  decodeSessionRouteKey,
  encodeSessionRouteKey,
  findSessionNode,
  flattenSessionTree,
  sessionKey,
} from './session-forest';

describe('session composite routing and forest', () => {
  it('round trips arbitrary unicode route identities without exposing a bare ID', () => {
    const ref = {
      connectionId: 'relay/一/\u{1f680}',
      relayTargetID: 'Windows ~ cafe\u0301',
      sessionId: 'ses/%?#/العربية/\u{1d11e}',
    };
    const encoded = encodeSessionRouteKey(ref);
    expect(encoded).toMatch(/^[0-9a-f]+$/);
    expect(encoded).not.toContain(ref.sessionId);
    expect(decodeSessionRouteKey(encoded)).toEqual(ref);
    expect(decodeSessionRouteKey('not hex')).toBeUndefined();
  });

  it('keeps the existing UTF-8 hex wire format for deep-link compatibility', () => {
    const ref = { connectionId: 'r', relayTargetID: '中', sessionId: '\u{1f600}' };
    expect(encodeSessionRouteKey(ref)).toBe('5b2272222c22e4b8ad222c22f09f9880225d');
  });

  it('does not require TextEncoder or TextDecoder globals and preserves lone surrogates', () => {
    const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
    const decoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextDecoder');
    try {
      Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: undefined });
      Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, value: undefined });
      const ref = {
        connectionId: 'relay-\ud800',
        relayTargetID: '\udfff-machine',
        sessionId: 'emoji-\u{1f469}\u200d\u{1f4bb}',
      };
      expect(decodeSessionRouteKey(encodeSessionRouteKey(ref))).toEqual(ref);
    } finally {
      restoreGlobalProperty('TextEncoder', encoderDescriptor);
      restoreGlobalProperty('TextDecoder', decoderDescriptor);
    }
  });

  it('rejects malformed hex, malformed UTF-8, and invalid composite payloads', () => {
    const malformed = [
      '',
      '0',
      'zz',
      '80', // unexpected continuation
      'c0af', // overlong two-byte form
      'e08080', // overlong three-byte form
      'eda080', // encoded UTF-16 surrogate
      'f0808080', // overlong four-byte form
      'f4908080', // above U+10FFFF
      'e282', // truncated sequence
      '5b226f6e6c792d6f6e65225d', // valid JSON with the wrong tuple shape
      '5b22222c226d616368696e65222c2273657373696f6e225d', // empty identity field
    ];
    for (const value of malformed) expect(decodeSessionRouteKey(value)).toBeUndefined();
  });

  it('keeps identical session IDs isolated per machine', () => {
    const sessions = [
      { id: 'same', title: 'Mac', relayTargetID: 'mac' },
      { id: 'same', title: 'Windows', relayTargetID: 'windows' },
    ];
    const forest = buildSessionForest(sessions, 'relay');
    expect(forest.nodes.size).toBe(2);
    expect(findSessionNode(forest, { connectionId: 'relay', relayTargetID: 'mac', sessionId: 'same' })?.session.title).toBe('Mac');
    expect(findSessionNode(forest, { connectionId: 'relay', relayTargetID: 'windows', sessionId: 'same' })?.session.title).toBe('Windows');
  });

  it('links only same-machine parents and sorts every level by newest activity', () => {
    const forest = buildSessionForest([
      { id: 'old-root', relayTargetID: 'mac', time: { updated: 10 } },
      { id: 'root', relayTargetID: 'mac', time: { updated: 30 } },
      { id: 'older-child', parentID: 'root', relayTargetID: 'mac', time: { updated: 20 } },
      { id: 'newer-child', parentID: 'root', relayTargetID: 'mac', time: { updated: 25 } },
      { id: 'wrong-machine-child', parentID: 'root', relayTargetID: 'windows', time: { updated: 40 } },
    ], 'relay');

    expect(forest.roots.map((node) => node.ref.sessionId)).toEqual(['wrong-machine-child', 'root', 'old-root']);
    expect(findSessionNode(forest, { connectionId: 'relay', relayTargetID: 'mac', sessionId: 'root' })?.children.map((node) => node.ref.sessionId)).toEqual([
      'newer-child',
      'older-child',
    ]);
    expect(forest.anomalies).toContainEqual(expect.objectContaining({ kind: 'orphan-parent', parentID: 'root' }));
  });

  it('turns self parents, cycles, and orphans into safe roots', () => {
    const forest = buildSessionForest([
      { id: 'self', parentID: 'self', relayTargetID: 'mac' },
      { id: 'a', parentID: 'b', relayTargetID: 'mac' },
      { id: 'b', parentID: 'a', relayTargetID: 'mac' },
      { id: 'orphan', parentID: 'missing', relayTargetID: 'mac' },
    ], 'relay');
    expect(forest.roots).toHaveLength(4);
    expect(forest.anomalies.map((item) => item.kind).sort()).toEqual(['cycle', 'cycle', 'orphan-parent', 'self-parent']);
    for (const node of forest.nodes.values()) {
      expect(node.parent).toBeNull();
      expect(sessionKey(node.ref)).toBe(node.key);
    }
  });

  it('flattens every hierarchy depth with current and anomaly metadata', () => {
    const forest = buildSessionForest([
      { id: 'older-root', relayTargetID: 'mac', time: { updated: 5 } },
      { id: 'root', relayTargetID: 'mac', time: { updated: 50 } },
      { id: 'older-child', parentID: 'root', relayTargetID: 'mac', time: { updated: 20 } },
      { id: 'child', parentID: 'root', relayTargetID: 'mac', time: { updated: 40 } },
      { id: 'grandchild', parentID: 'child', relayTargetID: 'mac', time: { updated: 30 } },
      { id: 'great-grandchild', parentID: 'grandchild', relayTargetID: 'mac', time: { updated: 10 } },
      { id: 'orphan', parentID: 'missing', relayTargetID: 'windows', time: { updated: 60 } },
      { id: 'orphan-child', parentID: 'orphan', relayTargetID: 'windows', time: { updated: 55 } },
    ], 'relay');

    const rows = flattenSessionTree(forest, {
      currentRef: { connectionId: 'relay', relayTargetID: 'mac', sessionId: 'grandchild' },
    });

    expect(rows.map((row) => [row.ref.sessionId, row.depth])).toEqual([
      ['orphan', 0],
      ['orphan-child', 1],
      ['root', 0],
      ['child', 1],
      ['grandchild', 2],
      ['great-grandchild', 3],
      ['older-child', 1],
      ['older-root', 0],
    ]);
    expect(rows.filter((row) => row.isCurrent).map((row) => row.ref.sessionId)).toEqual(['grandchild']);
    expect(rows.find((row) => row.ref.sessionId === 'orphan')?.anomalies).toEqual(['orphan-parent']);
    expect(new Set(rows.map((row) => row.key)).size).toBe(forest.nodes.size);
  });

  it('can flatten one component and identifies current sessions by composite identity', () => {
    const forest = buildSessionForest([
      { id: 'same', relayTargetID: 'mac', time: { updated: 20 } },
      { id: 'mac-child', parentID: 'same', relayTargetID: 'mac' },
      { id: 'same', relayTargetID: 'windows', time: { updated: 10 } },
      { id: 'windows-child', parentID: 'same', relayTargetID: 'windows' },
    ], 'relay');
    const windowsRoot = findSessionNode(forest, { connectionId: 'relay', relayTargetID: 'windows', sessionId: 'same' });
    expect(windowsRoot).toBeDefined();

    const rows = flattenSessionTree(forest, {
      currentRef: { connectionId: 'relay', relayTargetID: 'windows', sessionId: 'same' },
      roots: [windowsRoot!],
    });

    expect(rows.map((row) => row.ref.sessionId)).toEqual(['same', 'windows-child']);
    expect(rows.map((row) => row.isCurrent)).toEqual([true, false]);
  });
});

function restoreGlobalProperty(name: 'TextEncoder' | 'TextDecoder', descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
