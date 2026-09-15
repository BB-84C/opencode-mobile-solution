/**
 * Which surface currently has focus, as far as the desktop shell is concerned.
 *
 * The shell resolves a key against the surface the user is on: page-up scrolls
 * the transcript only in `messages`, and the diff viewer's single-letter keys
 * only in `diff`. Nothing reaches those bindings until a screen says where the
 * user is, so this is the piece that makes context-scoped keys reachable at all.
 *
 * Screens set the context; the shell bridge installs a sink to receive it. They
 * mount in either order, so the value is kept here and replayed to a sink that
 * arrives late.
 */

export type DesktopContext =
  | 'global'
  | 'input'
  | 'messages'
  | 'diff'
  | 'which_key'
  | 'dialog:select'
  | 'dialog:prompt'
  | 'dialog:mcp'
  | 'dialog:model'
  | 'dialog:stash'
  | 'dialog:move_session'
  | 'dialog:plugins'
  | 'dialog:autocomplete'
  | 'dialog:permission';

type ContextSink = (context: DesktopContext) => void;

let sink: ContextSink | null = null;
let current: DesktopContext = 'global';

export function installDesktopContextSink(next: ContextSink): () => void {
  sink = next;
  // A screen may have mounted before the shell bridge did; replay so the shell
  // does not spend the first keystrokes believing the user is still on 'global'.
  next(current);
  return () => {
    if (sink === next) sink = null;
  };
}

export function setDesktopContext(context: DesktopContext): void {
  if (context === current) return;
  current = context;
  sink?.(context);
}

export function currentDesktopContext(): DesktopContext {
  return current;
}

/** Test seam: the module holds process-wide state, so a test that changes it
 *  has to be able to put it back. */
export function resetDesktopContext(): void {
  sink = null;
  current = 'global';
}
