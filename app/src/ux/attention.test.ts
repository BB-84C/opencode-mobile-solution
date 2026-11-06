import { describe, expect, it } from 'vitest';

import type { PermissionRequest, QuestionRequest, Session } from '@/src/opencode/types';

import {
  attentionCountsByRoot,
  attentionNotification,
  collectAttention,
  failuresByRoot,
  planAttentionDelivery,
  replaceDirectoryRequests,
  summarizePermission,
  summarizeQuestion,
  unseenAttention,
} from './attention';
import { sessionKey } from './session-forest';

const host = 'host-1';
const target = 'mac';
const key = (sessionId: string) => sessionKey({ connectionId: host, relayTargetID: target, sessionId });

const sessions: Session[] = [
  { id: 'root', title: 'Refactor billing', relayTargetID: target, directory: '/repo' },
  { id: 'child', title: 'Run the tests', parentID: 'root', relayTargetID: target, directory: '/repo' },
  { id: 'grandchild', title: 'Check one file', parentID: 'child', relayTargetID: target, directory: '/repo' },
  { id: 'other', title: 'Elsewhere', relayTargetID: target, directory: '/other' },
];

function permission(id: string, sessionID: string, extra: Partial<PermissionRequest> = {}): PermissionRequest {
  return { id, sessionID, permission: 'bash', patterns: ['npm test'], metadata: { command: 'npm test' }, always: [], ...extra };
}

function question(id: string, sessionID: string): QuestionRequest {
  return { id, sessionID, questions: [{ header: 'Deploy', question: 'Deploy to staging now?', options: [] }] };
}

describe('replaceDirectoryRequests', () => {
  it('files a directory read under every session it names, child sessions included', () => {
    const next = replaceDirectoryRequests({}, { connectionId: host, relayTargetID: target }, ['root', 'child'], [
      permission('per_1', 'child'),
      permission('per_2', 'root'),
    ]);
    expect(next[key('child')].map((request) => request.id)).toEqual(['per_1']);
    expect(next[key('root')].map((request) => request.id)).toEqual(['per_2']);
  });

  it('clears sessions of that directory that no longer have anything pending, and leaves other directories alone', () => {
    const current = { [key('child')]: [permission('per_old', 'child')], [key('other')]: [permission('per_x', 'other')] };
    const next = replaceDirectoryRequests(current, { connectionId: host, relayTargetID: target }, ['root', 'child'], []);
    expect(next[key('child')]).toEqual([]);
    expect(next[key('other')].map((request) => request.id)).toEqual(['per_x']);
  });
});

describe('collectAttention', () => {
  const items = collectAttention({
    permissions: { [key('grandchild')]: [permission('per_1', 'grandchild')], [key('root')]: [] },
    questions: { [key('root')]: [question('que_1', 'root')] },
    sessions: { [host]: sessions },
  });

  it('lists every pending request with the session that asked and its root', () => {
    expect(items.map((item) => item.id).sort()).toEqual(['per_1', 'que_1']);
    const deep = items.find((item) => item.id === 'per_1')!;
    expect(deep.kind).toBe('permission');
    expect(deep.ref.sessionId).toBe('grandchild');
    expect(deep.rootRef.sessionId).toBe('root');
    expect(deep.sessionTitle).toBe('Check one file');
    expect(deep.rootTitle).toBe('Refactor billing');
  });

  it('counts requests against the root, so a parent shows what its subagents wait on', () => {
    const counts = attentionCountsByRoot(items);
    expect(counts.get(key('root'))).toBe(2);
    expect(counts.has(key('grandchild'))).toBe(false);
  });

  it('survives a parent cycle and an unknown session', () => {
    const looped = collectAttention({
      permissions: { [key('a')]: [permission('per_a', 'a')], [key('ghost')]: [permission('per_g', 'ghost')] },
      questions: {},
      sessions: {
        [host]: [
          { id: 'a', parentID: 'b', relayTargetID: target },
          { id: 'b', parentID: 'a', relayTargetID: target },
        ],
      },
    });
    expect(looped.map((item) => item.id).sort()).toEqual(['per_a', 'per_g']);
    expect(looped.find((item) => item.id === 'per_g')!.rootRef.sessionId).toBe('ghost');
  });
});

describe('failed sessions', () => {
  const items = collectAttention({
    permissions: { [key('root')]: [permission('per_1', 'root')] },
    questions: {},
    sessions: { [host]: sessions },
    failures: { [key('child')]: { id: 'evt_9', title: 'API error · 500', message: 'No available Claude accounts' }, [key('other')]: null },
  });

  it('files a subagent failure under its root, without counting it as something waiting', () => {
    const failure = items.find((item) => item.kind === 'error')!;
    expect(failure).toMatchObject({ id: 'evt_9', summary: 'API error · 500: No available Claude accounts' });
    expect(failure.rootRef.sessionId).toBe('root');
    expect(attentionCountsByRoot(items).get(key('root'))).toBe(1);
    expect(failuresByRoot(items).get(key('root'))?.id).toBe('evt_9');
  });

  it('announces it as a stopped session', () => {
    expect(attentionNotification(items.find((item) => item.kind === 'error')!).title).toBe('Session stopped on an error');
  });
});

describe('summaries and notifications', () => {
  it('shows the command a permission is for, falling back to its patterns', () => {
    expect(summarizePermission(permission('p', 's'))).toBe('bash: npm test');
    expect(summarizePermission(permission('p', 's', { permission: 'external_directory', metadata: {}, patterns: ['/etc/*'] })))
      .toBe('external_directory: /etc/*');
  });

  it('shows the first question', () => {
    expect(summarizeQuestion(question('q', 's'))).toBe('Deploy: Deploy to staging now?');
  });

  it('names the root and the subagent, and routes to the session that asked', () => {
    const [item] = collectAttention({
      permissions: { [key('child')]: [permission('per_1', 'child')] },
      questions: {},
      sessions: { [host]: sessions },
    });
    const notification = attentionNotification(item);
    expect(notification.title).toBe('Permission needed');
    expect(notification.body).toBe('Refactor billing › Run the tests\nbash: npm test');
    expect(notification.route).toMatch(/^\/session\/[0-9a-f]+$/);
  });

  it('reports only requests not announced before', () => {
    const items = collectAttention({
      permissions: { [key('root')]: [permission('per_1', 'root'), permission('per_2', 'root')] },
      questions: {},
      sessions: { [host]: sessions },
    });
    expect(unseenAttention(items, new Set(['per_1'])).map((item) => item.id)).toEqual(['per_2']);
  });
});

describe('planAttentionDelivery', () => {
  const items = collectAttention({
    permissions: { [key('child')]: [permission('per_1', 'child')], [key('other')]: [permission('per_2', 'other')] },
    questions: {},
    sessions: { [host]: sessions },
  });

  it('notifies each request on the desktop and banners only what the open screen does not show', () => {
    const plan = planAttentionDelivery(items, { canNotify: true, activeKey: key('root') });
    expect(plan.notifications).toHaveLength(2);
    expect(plan.banner?.id).toBe('per_2');
  });

  it('collapses a burst into one notification', () => {
    const burst = Array.from({ length: 5 }, (_, index) => ({ ...items[0], id: `per_${index}` }));
    const plan = planAttentionDelivery(burst, { canNotify: true, activeKey: null });
    expect(plan.notifications).toEqual([expect.objectContaining({ title: '5 sessions need you' })]);
  });

  it('only banners on a phone, and stays quiet when the request is already on screen', () => {
    expect(planAttentionDelivery(items, { canNotify: false, activeKey: null }).notifications).toEqual([]);
    expect(planAttentionDelivery([items[0]], { canNotify: false, activeKey: key('child') }).banner).toBeNull();
  });
});
