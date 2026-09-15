import { describe, expect, it } from 'vitest';

import { resolveDesktopAction } from './desktop-actions';
import { routeDesktopAction, storeBackedActions } from './desktop-router';

const route = (action: string, context = { hasSession: true }) =>
  routeDesktopAction(resolveDesktopAction(action), context);

describe('desktop action routing', () => {
  it('performs what the store can do with the session that is open', () => {
    expect(route('session_interrupt')).toEqual({ kind: 'store', action: 'interrupt' });
    expect(route('session_compact')).toEqual({ kind: 'store', action: 'compact' });
    expect(route('session_share')).toEqual({ kind: 'store', action: 'share' });
    expect(route('messages_copy')).toEqual({ kind: 'store', action: 'copy-transcript' });
  });

  it('refuses a session action when no session is open, and says why', () => {
    // Pressing escape on the host list should not look like a broken key, and it
    // must not reach a store method that would throw on a missing session.
    expect(route('session_interrupt', { hasSession: false }))
      .toEqual({ kind: 'report', action: 'interrupt', reason: 'no-session' });
    expect(route('session_compact', { hasSession: false }))
      .toEqual({ kind: 'report', action: 'compact', reason: 'no-session' });
  });

  it('still allows the actions that do not need a session', () => {
    expect(route('session_new', { hasSession: false })).toEqual({ kind: 'store', action: 'new-session' });
    expect(route('agent_cycle', { hasSession: false })).toEqual({ kind: 'store', action: 'cycle-agent' });
    expect(route('history_previous', { hasSession: false }))
      .toEqual({ kind: 'store', action: 'prompt-history-previous' });
  });

  it('hands an action to whichever screen registered for it', () => {
    const context = { hasSession: true, screenHandles: new Set(['scroll-page-up', 'entrypoint:diffs']) };

    expect(route('messages_page_up', context)).toEqual({ kind: 'screen', action: 'scroll-page-up' });
    expect(route('diff_open', context)).toEqual({ kind: 'screen', action: 'entrypoint:diffs' });
  });

  it('reports an action no screen claimed instead of dropping it', () => {
    // Scrolling needs a list only the session screen holds. With no screen
    // mounted the key has to report, or a user cannot tell a missing feature
    // from a dead keyboard.
    expect(route('messages_page_up', { hasSession: true }))
      .toEqual({ kind: 'report', action: 'scroll-page-up', reason: 'not-implemented' });
    expect(route('theme_list', { hasSession: true }))
      .toEqual({ kind: 'report', action: 'theme-list', reason: 'not-implemented' });
  });

  it('reports an action the mapping does not know at all', () => {
    expect(route('which_key_toggle')).toEqual({
      kind: 'report',
      action: 'which_key_toggle',
      reason: 'unsupported',
    });
  });

  it('never routes to a store action that is not declared', () => {
    // The two lookup tables and the capability table are separate objects; a
    // name present in one and missing from the other would only surface as a
    // crash at the moment a key is pressed.
    const declared = new Set<string>(storeBackedActions());
    const reached = new Set<string>();

    for (const action of [
      'session_interrupt', 'session_new', 'agent_cycle', 'variant_cycle',
      'session_compact', 'session_share', 'session_fork', 'messages_copy',
      'history_previous', 'history_next', 'prompt_stash_pop',
    ]) {
      const outcome = route(action);
      if (outcome.kind === 'store') reached.add(outcome.action);
    }

    expect([...reached].filter((action) => !declared.has(action))).toEqual([]);
    expect(reached.size).toBeGreaterThan(0);
  });
});
