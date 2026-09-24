/**
 * Where screens claim the keyboard actions only they can perform.
 *
 * Scrolling a transcript or opening a dialog needs state that lives in a screen,
 * not in the store. A screen registers while it is mounted and releases on the
 * way out, so a key pressed after navigating away reports "no screen" instead of
 * reaching a component that is gone.
 */

export type ScreenActionHandler = () => void;

export interface ScreenActionRegistry {
  register(action: string, handler: ScreenActionHandler): () => void;
  registerAll(handlers: Record<string, ScreenActionHandler>): () => void;
  claimed(): ReadonlySet<string>;
  invoke(action: string): boolean;
}

export function createScreenActionRegistry(): ScreenActionRegistry {
  const handlers = new Map<string, ScreenActionHandler>();

  const register = (action: string, handler: ScreenActionHandler) => {
    if (typeof handler !== 'function') throw new TypeError(`handler for ${action} must be a function`);
    // Last mount wins: navigating from one session to another replaces the
    // handler rather than leaving the old screen's closure in place.
    handlers.set(action, handler);
    return () => {
      if (handlers.get(action) === handler) handlers.delete(action);
    };
  };

  return {
    register,
    registerAll(next) {
      const disposers = Object.entries(next).map(([action, handler]) => register(action, handler));
      return () => disposers.forEach((dispose) => dispose());
    },
    claimed() {
      return new Set(handlers.keys());
    },
    invoke(action) {
      const handler = handlers.get(action);
      if (!handler) return false;
      handler();
      return true;
    },
  };
}

/** One registry per app instance; screens and the shell bridge share it. */
export const screenActionRegistry = createScreenActionRegistry();
