/**
 * Carries out a routed keyboard action.
 *
 * The routing decision and the act of performing it are separate so the first
 * can be tested without a store and the second without a keyboard. This module
 * is the second half: given an outcome, call the right thing and never let a
 * rejected promise escape into an unhandled rejection.
 */

import type { DesktopRouteOutcome, StoreActionId } from './desktop-router';
import type { ScreenActionRegistry } from './desktop-screen-registry';

export type DesktopStoreActions = Record<StoreActionId, () => unknown>;

export interface PerformDesktopActionOptions {
  outcome: DesktopRouteOutcome;
  store: Partial<DesktopStoreActions>;
  registry: Pick<ScreenActionRegistry, 'invoke'>;
  report: (message: string) => void;
  onError?: (error: Error) => void;
}

export type PerformResult =
  | { performed: 'store'; action: StoreActionId }
  | { performed: 'screen'; action: string }
  | { performed: 'reported'; action: string; message: string };

type ReportReason = Extract<DesktopRouteOutcome, { kind: 'report' }>['reason'];

const REPORT_TEXT: Record<ReportReason, (action: string) => string> = {
  'no-session': (action) => `${action} needs an open session`,
  'not-implemented': (action) => `${action} is not wired up yet`,
  unsupported: (action) => `${action} has no desktop equivalent yet`,
};

export function performDesktopAction(options: PerformDesktopActionOptions): PerformResult {
  const { outcome, store, registry, report, onError } = options;

  if (outcome.kind === 'store') {
    const run = store[outcome.action];
    if (!run) {
      const message = REPORT_TEXT['not-implemented'](outcome.action);
      report(message);
      return { performed: 'reported', action: outcome.action, message };
    }
    settle(run, onError);
    return { performed: 'store', action: outcome.action };
  }

  if (outcome.kind === 'screen') {
    if (registry.invoke(outcome.action)) return { performed: 'screen', action: outcome.action };
    // The screen released its handler between routing and performing, which is
    // ordinary during navigation. Say so rather than drop the key.
    const message = REPORT_TEXT['not-implemented'](outcome.action);
    report(message);
    return { performed: 'reported', action: outcome.action, message };
  }

  const message = REPORT_TEXT[outcome.reason](outcome.action);
  report(message);
  return { performed: 'reported', action: outcome.action, message };
}

/** Store actions are a mix of sync and async; a rejected one must surface as a
 *  reported error rather than an unhandled rejection that kills nothing and
 *  tells no one. */
function settle(run: () => unknown, onError?: (error: Error) => void) {
  try {
    const result = run();
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void (result as Promise<unknown>).catch((error: unknown) => {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    }
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}
