import { describe, expect, it } from 'vitest';

import { getTopLevelSessions } from './session-visibility';

describe('top-level session visibility', () => {
  it('keeps child sessions available internally but excludes them from recent-session entry points', () => {
    const sessions = [
      { id: 'root', title: 'Main session' },
      { id: 'child', title: 'Explorer subagent', parentID: 'root' },
      { id: 'root-2', title: 'Another main session' },
    ];

    expect(getTopLevelSessions(sessions).map((session) => session.id)).toEqual(['root', 'root-2']);
    expect(sessions).toHaveLength(3);
  });
});
