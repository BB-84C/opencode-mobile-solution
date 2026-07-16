import type { Session } from '@/src/opencode/types';

export interface SessionListFilter {
  query?: string;
  relayTargetID?: string | null;
}

export function filterAndSortRootSessions(sessions: Session[], filter: SessionListFilter = {}) {
  const query = filter.query?.trim().toLocaleLowerCase() ?? '';
  // parentID is the authoritative OpenCode root/child contract. The main
  // session index must never promote an orphan, a self-parent, a cycle, or an
  // SSE child that arrived before its parent. Forest recovery belongs only in
  // the explicit hierarchy/diagnostic surface.
  return sessions
    .filter((session) => !session.parentID)
    .filter((session) => !filter.relayTargetID || session.relayTargetID === filter.relayTargetID)
    .filter((session) => !query || sessionSearchText(session).includes(query))
    .sort(compareRootSessionRecency);
}

export function sessionSearchText(session: Session) {
  return [
    session.title,
    session.id,
    session.directory,
    session.path,
    session.location?.directory,
    session.relayTargetName,
    session.relayTargetID,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLocaleLowerCase();
}

export function sessionUpdatedAt(session: Session) {
  return sessionTimestamp(session, 'updated');
}

function compareRootSessionRecency(left: Session, right: Session) {
  const updated = sessionTimestamp(right, 'updated') - sessionTimestamp(left, 'updated');
  if (updated !== 0) return updated;
  const created = sessionTimestamp(right, 'created') - sessionTimestamp(left, 'created');
  if (created !== 0) return created;
  const target = (left.relayTargetID ?? '').localeCompare(right.relayTargetID ?? '');
  return target !== 0 ? target : left.id.localeCompare(right.id);
}

function sessionTimestamp(session: Session, field: 'created' | 'updated') {
  const numeric = session.time?.[field];
  if (typeof numeric === 'number' && Number.isFinite(numeric)) return numeric;
  const legacy = session[field];
  if (!legacy) return 0;
  const parsed = Date.parse(legacy);
  return Number.isFinite(parsed) ? parsed : 0;
}
