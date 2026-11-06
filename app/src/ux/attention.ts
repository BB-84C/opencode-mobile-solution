import type { PermissionRequest, QuestionRequest, Session } from '@/src/opencode/types';

import { encodeSessionRouteKey, sessionKey, type SessionRef } from './session-forest';

/**
 * What needs the user: every pending permission and question on every session
 * the app knows about, each tied to the root session a person would recognise.
 *
 * Permissions are mostly raised by subagents, in child sessions nobody is
 * looking at. Showing only the open session's own requests is how work stalled
 * with nothing on screen, so everything here is resolved up to the root.
 */

/** `error` is a session that stopped on a failed turn: nothing to answer, but the work is not moving. */
export type AttentionKind = 'permission' | 'question' | 'error';

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  ref: SessionRef;
  rootRef: SessionRef;
  sessionTitle: string;
  rootTitle: string;
  summary: string;
}

const DIRECT_TARGET = '__opencode_direct__';
const MAX_SUMMARY = 160;

function clip(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY - 1)}…` : flat;
}

export function summarizePermission(request: PermissionRequest) {
  const command = request.metadata?.command;
  const subject = typeof command === 'string' && command.trim() ? command : (request.patterns ?? []).join(', ');
  return clip(subject ? `${request.permission}: ${subject}` : request.permission);
}

export function summarizeQuestion(request: QuestionRequest) {
  const first = request.questions?.[0];
  if (!first) return 'Question';
  return clip(first.header ? `${first.header}: ${first.question}` : first.question);
}

/**
 * Files one directory's pending requests under the sessions they belong to.
 * The server's list for a directory is authoritative for every session in it,
 * so a session of that directory with nothing in the list is cleared.
 */
export function replaceDirectoryRequests<T extends { sessionID: string }>(
  current: Record<string, T[]>,
  scope: { connectionId: string; relayTargetID: string },
  sessionIdsInDirectory: Iterable<string>,
  fetched: readonly T[],
): Record<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const request of fetched) grouped.set(request.sessionID, [...(grouped.get(request.sessionID) ?? []), request]);
  const next = { ...current };
  for (const sessionId of new Set([...sessionIdsInDirectory, ...grouped.keys()])) {
    next[sessionKey({ ...scope, sessionId })] = grouped.get(sessionId) ?? [];
  }
  return next;
}

function decodeKey(key: string): SessionRef | undefined {
  try {
    const value = JSON.parse(key) as unknown;
    if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'string' && item)) {
      return { connectionId: value[0], relayTargetID: value[1], sessionId: value[2] };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function sessionLookup(sessions: Record<string, readonly Session[]>) {
  const byKey = new Map<string, Session>();
  for (const [connectionId, list] of Object.entries(sessions)) {
    for (const session of list) {
      byKey.set(sessionKey({ connectionId, relayTargetID: session.relayTargetID ?? DIRECT_TARGET, sessionId: session.id }), session);
    }
  }
  return byKey;
}

function rootOf(ref: SessionRef, byKey: Map<string, Session>) {
  let current = ref;
  const visited = new Set<string>();
  for (;;) {
    const key = sessionKey(current);
    if (visited.has(key)) return current;
    visited.add(key);
    const parent = byKey.get(key)?.parentID;
    if (!parent) return current;
    const parentRef = { ...current, sessionId: parent };
    if (!byKey.has(sessionKey(parentRef))) return current;
    current = parentRef;
  }
}

export function collectAttention(input: {
  permissions: Record<string, readonly PermissionRequest[]>;
  questions: Record<string, readonly QuestionRequest[]>;
  sessions: Record<string, readonly Session[]>;
  failures?: Record<string, { id: string; title: string; message: string } | null>;
}): AttentionItem[] {
  const byKey = sessionLookup(input.sessions);
  const titleOf = (ref: SessionRef) => byKey.get(sessionKey(ref))?.title?.trim() || 'Untitled session';
  const items: AttentionItem[] = [];
  const add = (key: string, kind: AttentionKind, id: string, summary: string) => {
    const ref = decodeKey(key);
    if (!ref) return;
    const rootRef = rootOf(ref, byKey);
    items.push({ id, kind, ref, rootRef, sessionTitle: titleOf(ref), rootTitle: titleOf(rootRef), summary });
  };
  for (const [key, requests] of Object.entries(input.permissions)) {
    for (const request of requests) add(key, 'permission', request.id, summarizePermission(request));
  }
  for (const [key, requests] of Object.entries(input.questions)) {
    for (const request of requests) add(key, 'question', request.id, summarizeQuestion(request));
  }
  for (const [key, failure] of Object.entries(input.failures ?? {})) {
    if (failure) add(key, 'error', failure.id, clip(`${failure.title}: ${failure.message}`));
  }
  return items;
}

export function attentionCountsByRoot(items: readonly AttentionItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.kind === 'error') continue;
    const key = sessionKey(item.rootRef);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The failure to show on each root session's card, if its work stopped on an error. */
export function failuresByRoot(items: readonly AttentionItem[]) {
  const failures = new Map<string, AttentionItem>();
  for (const item of items) if (item.kind === 'error') failures.set(sessionKey(item.rootRef), item);
  return failures;
}

export function unseenAttention(items: readonly AttentionItem[], seen: ReadonlySet<string>) {
  return items.filter((item) => !seen.has(item.id));
}

export function attentionRoute(item: AttentionItem) {
  return `/session/${encodeSessionRouteKey(item.ref)}`;
}

export function attentionNotification(item: AttentionItem) {
  const where = item.ref.sessionId === item.rootRef.sessionId
    ? item.rootTitle
    : `${item.rootTitle} › ${item.sessionTitle}`;
  return {
    title: item.kind === 'permission' ? 'Permission needed' : item.kind === 'question' ? 'Question waiting' : 'Session stopped on an error',
    body: `${where}\n${item.summary}`,
    route: attentionRoute(item),
  };
}

const NOTIFY_INDIVIDUALLY_UP_TO = 3;

/**
 * Decides how newly seen requests reach the user. A desktop shell raises a
 * system notification for each, collapsed into one when a burst arrives (a
 * relaunch finds everything that piled up). Either way, a request the open
 * screen is not already showing also gets an in-app banner.
 */
export function planAttentionDelivery(
  fresh: readonly AttentionItem[],
  context: { canNotify: boolean; activeKey: string | null },
) {
  const notifications = !context.canNotify || fresh.length === 0
    ? []
    : fresh.length <= NOTIFY_INDIVIDUALLY_UP_TO
      ? fresh.map(attentionNotification)
      : [{
        title: `${fresh.length} sessions need you`,
        body: fresh.slice(0, 2).map((item) => attentionNotification(item).body.split('\n')[0]).join('\n'),
        route: attentionRoute(fresh[0]),
      }];
  const hidden = fresh.filter((item) =>
    sessionKey(item.ref) !== context.activeKey && sessionKey(item.rootRef) !== context.activeKey);
  return { notifications, banner: hidden.at(-1) ?? null };
}
