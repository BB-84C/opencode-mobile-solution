/**
 * Connects the desktop shell's keyboard layer to the app.
 *
 * The shell claims a key, resolves it against opencode's keybinding table, and
 * sends an action name. This turns that into one of the app's own actions and
 * hands it to a dispatcher. The app tells the shell which surface has focus so
 * the same key can mean different things in a dialog and in the prompt.
 *
 * On a phone there is no shell. Rather than branch on platform at every call
 * site, the bridge is inert when the host object is absent.
 */

import { resolveDesktopAction, type DesktopActionTarget } from './desktop-actions';

export interface DesktopShellHost {
  setContext(context: string): void;
  onAction(handler: (payload: { action: string; context?: string }) => void): () => void;
  describeKeymap?(): Promise<unknown>;
}

export interface DesktopActionBridge {
  readonly available: boolean;
  setContext(context: string): void;
  dispose(): void;
}

export interface DesktopBridgeOptions {
  host?: DesktopShellHost | null;
  dispatch: (target: DesktopActionTarget, source: { action: string; context?: string }) => void;
  onError?: (error: Error) => void;
}

const INERT: DesktopActionBridge = {
  available: false,
  setContext() {},
  dispose() {},
};

export function createDesktopActionBridge({ host, dispatch, onError }: DesktopBridgeOptions): DesktopActionBridge {
  if (!host || typeof host.onAction !== 'function') return INERT;

  let disposed = false;
  const unsubscribe = host.onAction((payload) => {
    if (disposed) return;
    const action = payload?.action;
    if (typeof action !== 'string' || action.length === 0) return;
    try {
      dispatch(resolveDesktopAction(action), { action, context: payload?.context });
    } catch (error) {
      // A throwing handler must not tear down the subscription, or one bad
      // action would leave every later key dead with no sign of why.
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    available: true,
    setContext(context: string) {
      if (disposed) return;
      try {
        host.setContext(context);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
    },
  };
}

/** Reads the shell bridge the preload exposes, if this build is running in one. */
export function detectDesktopShellHost(scope: unknown = globalThis): DesktopShellHost | null {
  const candidate = (scope as { cockpit?: DesktopShellHost } | undefined)?.cockpit;
  if (!candidate || typeof candidate.onAction !== 'function' || typeof candidate.setContext !== 'function') {
    return null;
  }
  return candidate;
}
