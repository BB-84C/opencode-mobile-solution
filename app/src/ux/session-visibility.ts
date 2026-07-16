import type { Session } from '@/src/opencode/types';

export function getTopLevelSessions(sessions: Session[]) {
  return sessions.filter((session) => !session.parentID);
}
