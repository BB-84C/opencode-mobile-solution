import type { Session } from '@/src/opencode/types';

export interface SessionRef {
  connectionId: string;
  relayTargetID: string;
  sessionId: string;
}

export type SessionForestAnomalyKind = 'duplicate' | 'orphan-parent' | 'self-parent' | 'cycle';

export interface SessionForestAnomaly {
  kind: SessionForestAnomalyKind;
  ref: SessionRef;
  parentID?: string;
}

export interface SessionForestNode {
  key: string;
  ref: SessionRef;
  session: Session;
  parent: SessionForestNode | null;
  children: SessionForestNode[];
  anomalies: SessionForestAnomalyKind[];
}

export interface SessionForest {
  roots: SessionForestNode[];
  nodes: Map<string, SessionForestNode>;
  anomalies: SessionForestAnomaly[];
}

export interface SessionTreeRow {
  key: string;
  ref: SessionRef;
  session: Session;
  node: SessionForestNode;
  depth: number;
  isCurrent: boolean;
  anomalies: readonly SessionForestAnomalyKind[];
}

export interface FlattenSessionTreeOptions {
  currentRef?: SessionRef | null;
  /** Defaults to every safe root. Supply a subset to render one component. */
  roots?: readonly SessionForestNode[];
}

export function sessionKey(ref: SessionRef) {
  return JSON.stringify([ref.connectionId, ref.relayTargetID, ref.sessionId]);
}

/** A URL-safe, reversible representation that never treats a bare session ID as globally unique. */
export function encodeSessionRouteKey(ref: SessionRef) {
  return encodeUtf8Hex(sessionKey(assertCompleteRef(ref)));
}

export function decodeSessionRouteKey(value: string): SessionRef | undefined {
  if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return undefined;
  try {
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    const json = decodeUtf8(bytes);
    if (json === undefined) return undefined;
    const decoded = JSON.parse(json) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 3 || !decoded.every(isNonEmptyString)) return undefined;
    return { connectionId: decoded[0], relayTargetID: decoded[1], sessionId: decoded[2] };
  } catch {
    return undefined;
  }
}

/**
 * Encodes Unicode scalar values as UTF-8 without relying on TextEncoder, which
 * is not present in every Hermes runtime. JSON.stringify escapes lone UTF-16
 * surrogates, so route identities containing them still round-trip exactly.
 */
function encodeUtf8Hex(value: string) {
  let result = '';
  const appendByte = (byte: number) => {
    result += byte.toString(16).padStart(2, '0');
  };

  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (second < 0xdc00 || second > 0xdfff) {
        throw new Error('Cannot encode an unpaired UTF-16 surrogate');
      }
      codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new Error('Cannot encode an unpaired UTF-16 surrogate');
    }

    if (codePoint <= 0x7f) {
      appendByte(codePoint);
    } else if (codePoint <= 0x7ff) {
      appendByte(0xc0 | (codePoint >> 6));
      appendByte(0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      appendByte(0xe0 | (codePoint >> 12));
      appendByte(0x80 | ((codePoint >> 6) & 0x3f));
      appendByte(0x80 | (codePoint & 0x3f));
    } else {
      appendByte(0xf0 | (codePoint >> 18));
      appendByte(0x80 | ((codePoint >> 12) & 0x3f));
      appendByte(0x80 | ((codePoint >> 6) & 0x3f));
      appendByte(0x80 | (codePoint & 0x3f));
    }
  }
  return result;
}

/** Strict UTF-8 decoding: rejects truncation, overlong forms, surrogates, and > U+10FFFF. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  let result = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    let codePoint: number;
    let width: number;

    if (first <= 0x7f) {
      codePoint = first;
      width = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      width = 2;
      if (index + width > bytes.length || !isContinuationByte(bytes[index + 1])) return undefined;
      codePoint = ((first & 0x1f) << 6) | (bytes[index + 1] & 0x3f);
    } else if (first >= 0xe0 && first <= 0xef) {
      width = 3;
      if (
        index + width > bytes.length
        || !isContinuationByte(bytes[index + 1])
        || !isContinuationByte(bytes[index + 2])
        || (first === 0xe0 && bytes[index + 1] < 0xa0)
        || (first === 0xed && bytes[index + 1] > 0x9f)
      ) return undefined;
      codePoint = ((first & 0x0f) << 12) | ((bytes[index + 1] & 0x3f) << 6) | (bytes[index + 2] & 0x3f);
    } else if (first >= 0xf0 && first <= 0xf4) {
      width = 4;
      if (
        index + width > bytes.length
        || !isContinuationByte(bytes[index + 1])
        || !isContinuationByte(bytes[index + 2])
        || !isContinuationByte(bytes[index + 3])
        || (first === 0xf0 && bytes[index + 1] < 0x90)
        || (first === 0xf4 && bytes[index + 1] > 0x8f)
      ) return undefined;
      codePoint = ((first & 0x07) << 18)
        | ((bytes[index + 1] & 0x3f) << 12)
        | ((bytes[index + 2] & 0x3f) << 6)
        | (bytes[index + 3] & 0x3f);
    } else {
      return undefined;
    }

    if (codePoint <= 0xffff) {
      result += String.fromCharCode(codePoint);
    } else {
      const scalar = codePoint - 0x10000;
      result += String.fromCharCode(0xd800 + (scalar >> 10), 0xdc00 + (scalar & 0x3ff));
    }
    index += width;
  }
  return result;
}

function isContinuationByte(value: number) {
  return value >= 0x80 && value <= 0xbf;
}

export function sessionRefForSession(connectionId: string, session: Session, directTargetID = '__opencode_direct__'): SessionRef {
  return {
    connectionId,
    relayTargetID: session.relayTargetID ?? directTargetID,
    sessionId: session.id,
  };
}

export function buildSessionForest(
  sessions: readonly Session[],
  connectionId: string,
  directTargetID = '__opencode_direct__',
): SessionForest {
  const nodes = new Map<string, SessionForestNode>();
  const anomalies: SessionForestAnomaly[] = [];

  for (const session of [...sessions].sort(compareSessionRecency)) {
    const ref = sessionRefForSession(connectionId, session, directTargetID);
    const key = sessionKey(ref);
    if (nodes.has(key)) {
      anomalies.push({ kind: 'duplicate', ref });
      continue;
    }
    nodes.set(key, { key, ref, session, parent: null, children: [], anomalies: [] });
  }

  const parentKeys = new Map<string, string>();
  for (const node of nodes.values()) {
    const parentID = node.session.parentID;
    if (!parentID) continue;
    if (parentID === node.ref.sessionId) {
      recordAnomaly(node, 'self-parent', anomalies, parentID);
      continue;
    }
    const parentKey = sessionKey({ ...node.ref, sessionId: parentID });
    if (!nodes.has(parentKey)) {
      recordAnomaly(node, 'orphan-parent', anomalies, parentID);
      continue;
    }
    parentKeys.set(node.key, parentKey);
  }

  // Break every cycle before linking. Descendants remain attached to a cycle
  // node, which becomes a safe root after its own cyclic edge is removed.
  const visited = new Set<string>();
  for (const start of nodes.keys()) {
    if (visited.has(start)) continue;
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let cursor: string | undefined = start;
    while (cursor && !visited.has(cursor)) {
      const repeatedAt = pathIndex.get(cursor);
      if (repeatedAt !== undefined) {
        for (const cycleKey of path.slice(repeatedAt)) {
          const node = nodes.get(cycleKey);
          if (!node) continue;
          recordAnomaly(node, 'cycle', anomalies, node.session.parentID);
          parentKeys.delete(cycleKey);
        }
        break;
      }
      pathIndex.set(cursor, path.length);
      path.push(cursor);
      cursor = parentKeys.get(cursor);
    }
    for (const key of path) visited.add(key);
  }

  for (const [childKey, parentKey] of parentKeys) {
    const child = nodes.get(childKey);
    const parent = nodes.get(parentKey);
    if (!child || !parent) continue;
    child.parent = parent;
    parent.children.push(child);
  }
  for (const node of nodes.values()) node.children.sort(compareNodeRecency);
  const roots = [...nodes.values()].filter((node) => !node.parent).sort(compareNodeRecency);
  return { roots, nodes, anomalies };
}

export function findSessionNode(forest: SessionForest, ref: SessionRef) {
  return forest.nodes.get(sessionKey(ref));
}

/**
 * Flattens every requested conversation component in pre-order. The forest
 * has already removed unsafe edges, while the visited guard keeps this helper
 * safe even if a caller supplies malformed custom roots.
 */
export function flattenSessionTree(
  forest: SessionForest,
  options: FlattenSessionTreeOptions = {},
): SessionTreeRow[] {
  const rows: SessionTreeRow[] = [];
  const visited = new Set<string>();
  const currentKey = options.currentRef ? sessionKey(options.currentRef) : null;

  function visit(node: SessionForestNode, depth: number) {
    if (visited.has(node.key)) return;
    visited.add(node.key);
    rows.push({
      key: node.key,
      ref: node.ref,
      session: node.session,
      node,
      depth,
      isCurrent: node.key === currentKey,
      anomalies: node.anomalies,
    });
    for (const child of node.children) visit(child, depth + 1);
  }

  for (const root of options.roots ?? forest.roots) visit(root, 0);
  return rows;
}

function assertCompleteRef(ref: SessionRef) {
  if (![ref.connectionId, ref.relayTargetID, ref.sessionId].every(isNonEmptyString)) {
    throw new Error('Session route requires relay, machine, and session identity');
  }
  return ref;
}

function recordAnomaly(
  node: SessionForestNode,
  kind: SessionForestAnomalyKind,
  anomalies: SessionForestAnomaly[],
  parentID?: string,
) {
  if (!node.anomalies.includes(kind)) node.anomalies.push(kind);
  anomalies.push({ kind, ref: node.ref, ...(parentID ? { parentID } : {}) });
}

function compareNodeRecency(left: SessionForestNode, right: SessionForestNode) {
  return compareSessionRecency(left.session, right.session);
}

function compareSessionRecency(left: Session, right: Session) {
  const updated = timestamp(right, 'updated') - timestamp(left, 'updated');
  if (updated !== 0) return updated;
  const created = timestamp(right, 'created') - timestamp(left, 'created');
  if (created !== 0) return created;
  return left.id.localeCompare(right.id);
}

function timestamp(session: Session, field: 'created' | 'updated') {
  const numeric = session.time?.[field];
  if (typeof numeric === 'number' && Number.isFinite(numeric)) return numeric;
  const legacy = session[field];
  if (!legacy) return 0;
  const parsed = Date.parse(legacy);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
