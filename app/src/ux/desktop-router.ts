/**
 * Decides who performs an action the desktop shell sent.
 *
 * Three outcomes, and the third is the point of the module:
 *
 *   store   - the store can do it now, with the session that is open
 *   screen  - it needs state only a screen holds (scroll position, which dialog
 *             is open), so whichever screen registered a handler gets it
 *   report  - nobody can do it yet
 *
 * A key that resolves to nothing must say so. Swallowing it is what makes a
 * keyboard feel broken, because the user cannot tell a missing feature from a
 * dead key.
 */

import type { DesktopActionTarget } from './desktop-actions';

export type DesktopRouteOutcome =
  | { kind: 'store'; action: StoreActionId }
  | { kind: 'screen'; action: string }
  | { kind: 'report'; action: string; reason: 'no-session' | 'not-implemented' | 'unsupported' };

export type StoreActionId =
  | 'interrupt'
  | 'compact'
  | 'share'
  | 'fork'
  | 'copy-transcript'
  | 'cycle-agent'
  | 'cycle-variant'
  | 'prompt-history-previous'
  | 'prompt-history-next'
  | 'prompt-stash-pop'
  | 'new-session';

/** Store-backed actions, and whether they need an open session. */
const STORE_ACTIONS: Record<StoreActionId, { needsSession: boolean }> = {
  interrupt: { needsSession: true },
  compact: { needsSession: true },
  share: { needsSession: true },
  fork: { needsSession: true },
  'copy-transcript': { needsSession: true },
  'cycle-variant': { needsSession: true },
  'cycle-agent': { needsSession: false },
  'prompt-history-previous': { needsSession: false },
  'prompt-history-next': { needsSession: false },
  'prompt-stash-pop': { needsSession: false },
  'new-session': { needsSession: false },
};

const NATIVE_TO_STORE: Record<string, StoreActionId> = {
  interrupt: 'interrupt',
  'new-session': 'new-session',
  'cycle-agent': 'cycle-agent',
  'cycle-variant': 'cycle-variant',
};

const COMMAND_TO_STORE: Record<string, StoreActionId> = {
  compact: 'compact',
  share: 'share',
  fork: 'fork',
  copy: 'copy-transcript',
  'prompt-history-previous': 'prompt-history-previous',
  'prompt-history-next': 'prompt-history-next',
  'prompt-stash-pop': 'prompt-stash-pop',
};

export interface DesktopRouteContext {
  hasSession: boolean;
  /** Actions a screen has registered a handler for, by the id the shell sends. */
  screenHandles?: ReadonlySet<string>;
}

export function routeDesktopAction(
  target: DesktopActionTarget,
  context: DesktopRouteContext,
): DesktopRouteOutcome {
  if (target.kind === 'unsupported') {
    return { kind: 'report', action: target.action, reason: 'unsupported' };
  }

  const storeAction = target.kind === 'native'
    ? NATIVE_TO_STORE[target.id]
    : target.kind === 'command'
      ? COMMAND_TO_STORE[target.id]
      : undefined;

  if (storeAction) {
    if (STORE_ACTIONS[storeAction].needsSession && !context.hasSession) {
      return { kind: 'report', action: storeAction, reason: 'no-session' };
    }
    return { kind: 'store', action: storeAction };
  }

  const id = target.kind === 'entrypoint' ? `entrypoint:${target.id}` : target.id;
  if (context.screenHandles?.has(id)) return { kind: 'screen', action: id };

  return { kind: 'report', action: id, reason: 'not-implemented' };
}

export function storeBackedActions(): StoreActionId[] {
  return Object.keys(STORE_ACTIONS).sort() as StoreActionId[];
}
