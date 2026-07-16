import { describe, expect, it } from 'vitest';

import { filterAndSortRootSessions, sessionSearchText, sessionUpdatedAt } from './session-list';

describe('session list projection', () => {
  const sessions = [
    {
      id: 'win-new',
      title: 'Windows deploy',
      directory: 'D:\\workspace',
      relayTargetID: 'windows',
      relayTargetName: 'Server',
      time: { updated: 300 },
    },
    {
      id: 'mac-iso',
      title: 'iOS App Test session',
      directory: '/Users/example/Documents/GitHub',
      relayTargetID: 'mac',
      relayTargetName: 'MacBook',
      updated: '1970-01-01T00:00:00.200Z',
    },
    {
      id: 'child',
      parentID: 'win-new',
      title: 'Hidden child',
      directory: 'D:\\workspace',
      relayTargetID: 'windows',
      time: { updated: 999 },
    },
    {
      id: 'untimed',
      title: 'Old notes',
      directory: '/tmp',
      relayTargetID: 'mac',
    },
  ];

  it('shows only roots and sorts newest activity first across numeric and ISO timestamps', () => {
    const originalOrder = sessions.map((session) => session.id);
    expect(filterAndSortRootSessions(sessions).map((session) => session.id)).toEqual([
      'win-new',
      'mac-iso',
      'untimed',
    ]);
    expect(sessions.map((session) => session.id)).toEqual(originalOrder);
  });

  it('searches title, machine, directory, target id, and session id', () => {
    expect(filterAndSortRootSessions(sessions, { query: 'ios app' }).map((session) => session.id)).toEqual(['mac-iso']);
    expect(filterAndSortRootSessions(sessions, { query: 'server' }).map((session) => session.id)).toEqual(['win-new']);
    expect(filterAndSortRootSessions(sessions, { query: 'documents/github' }).map((session) => session.id)).toEqual(['mac-iso']);
    expect(filterAndSortRootSessions(sessions, { query: 'windows' }).map((session) => session.id)).toEqual(['win-new']);
    expect(filterAndSortRootSessions(sessions, { query: 'untimed' }).map((session) => session.id)).toEqual(['untimed']);
  });

  it('filters by the relay-provided machine identity without hardcoded names', () => {
    expect(filterAndSortRootSessions(sessions, { relayTargetID: 'mac' }).map((session) => session.id)).toEqual([
      'mac-iso',
      'untimed',
    ]);
  });

  it('never promotes child, orphaned, self-parented, or cyclic sessions into the root list', () => {
    const malformed = [
      { id: 'normal-root', relayTargetID: 'mac', time: { updated: 10 } },
      { id: 'normal-child', parentID: 'normal-root', relayTargetID: 'mac', time: { updated: 90 } },
      { id: 'orphan', parentID: 'missing', relayTargetID: 'windows', title: 'Recover me', time: { updated: 50 } },
      { id: 'self', parentID: 'self', relayTargetID: 'mac', time: { updated: 40 } },
      { id: 'cycle-a', parentID: 'cycle-b', relayTargetID: 'mac', time: { updated: 30 } },
      { id: 'cycle-b', parentID: 'cycle-a', relayTargetID: 'mac', time: { updated: 20 } },
    ];

    expect(filterAndSortRootSessions(malformed).map((session) => session.id)).toEqual(['normal-root']);
    expect(filterAndSortRootSessions(malformed, { query: 'recover' })).toEqual([]);
    expect(filterAndSortRootSessions(malformed, { relayTargetID: 'windows' })).toEqual([]);
  });

  it('normalizes searchable text and legacy timestamps', () => {
    expect(sessionSearchText(sessions[0])).toContain('d:\\workspace');
    expect(sessionUpdatedAt(sessions[1])).toBe(200);
    expect(sessionUpdatedAt(sessions[3])).toBe(0);
  });
});
