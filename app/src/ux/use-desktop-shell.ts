/**
 * Mounts the desktop shell's keyboard bridge.
 *
 * Thin on purpose: translation, routing and performing are pure modules with
 * their own tests, so this only subscribes while the app is mounted and hands
 * the store methods over. On a phone the bridge reports itself unavailable and
 * nothing here runs.
 */

import { useEffect } from 'react';

import { useOpenCodeMobileStore } from '../store/mobile-store';
import { resolveDesktopAction } from './desktop-actions';
import { createDesktopActionBridge, detectDesktopShellHost } from './desktop-bridge';
import { installDesktopContextSink, setDesktopContext, type DesktopContext } from './desktop-context';
import { performDesktopAction, type DesktopStoreActions } from './desktop-perform';
import { routeDesktopAction } from './desktop-router';
import { screenActionRegistry } from './desktop-screen-registry';

export function useDesktopShell(): void {
  useEffect(() => {
    const host = detectDesktopShellHost();
    if (!host) return undefined;

    const report = (message: string) => useOpenCodeMobileStore.setState({ error: message });

    const bridge = createDesktopActionBridge({
      host,
      onError: (error) => report(error.message),
      dispatch: (target, source) => {
        // Read the store at press time rather than closing over a snapshot: the
        // active session changes while this subscription stays mounted.
        const state = useOpenCodeMobileStore.getState();
        const ref = state.activeSessionRef;

        const storeActions: Partial<DesktopStoreActions> = {
          interrupt: () => (ref ? state.requestInterrupt(ref) : undefined),
          compact: () => (ref ? state.compactSession(ref) : undefined),
          share: () => (ref ? state.shareSession(ref) : undefined),
          fork: () => (ref ? state.forkSession(ref) : undefined),
          'copy-transcript': () => (ref ? state.copySessionTranscript(ref) : undefined),
          'cycle-variant': () => (ref ? state.cycleSessionVariant(ref) : undefined),
          'cycle-agent': () => state.cycleAgent(),
          'prompt-history-previous': () => state.previousPromptFromHistory(),
          'prompt-history-next': () => state.nextPromptFromHistory(),
          'prompt-stash-pop': () => state.popStashedPrompt(),
        };

        performDesktopAction({
          outcome: routeDesktopAction(target, {
            hasSession: Boolean(ref),
            screenHandles: screenActionRegistry.claimed(),
          }),
          store: storeActions,
          registry: screenActionRegistry,
          report,
          onError: (error) => report(error.message),
        });

        void source;
      },
    });

    // Without this every key resolves as 'global', where no transcript, prompt or diff binding exists.
    const uninstallContext = installDesktopContextSink((context) => bridge.setContext(context));

    return () => {
      uninstallContext();
      bridge.dispose();
    };
  }, []);
}

/** Declares which surface a screen is, for as long as it is mounted. */
export function useDesktopContext(context: DesktopContext): void {
  useEffect(() => {
    setDesktopContext(context);
    return () => setDesktopContext('global');
  }, [context]);
}

/** Lets a screen claim the actions only it can perform, for as long as it is
 *  mounted. */
export function useScreenActions(handlers: Record<string, () => void>, deps: unknown[] = []): void {
  useEffect(() => screenActionRegistry.registerAll(handlers), deps);
}
