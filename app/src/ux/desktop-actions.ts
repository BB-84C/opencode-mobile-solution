/**
 * Translates opencode's TUI action names into the actions this app already has.
 *
 * The desktop shell claims a key, resolves it against opencode's keybinding
 * table, and hands back an action name like `session_compact`. The app speaks a
 * different vocabulary: command-palette ids, entrypoints, and a few things only
 * the session screen can do. Without a translation the shell would swallow keys
 * and nothing would happen, which is worse than not binding them at all.
 *
 * Anything absent from the table is reported as unsupported rather than ignored,
 * so a key that does nothing can say so instead of looking broken.
 */

import type { CommandEntrypointId, CommandPaletteActionId } from './tui-actions';
import { commandPaletteEntrypoints, getCommandPaletteActions } from './tui-actions';

/** Actions the session screen performs directly, outside the command palette. */
export type DesktopNativeActionId =
  | 'interrupt'
  | 'new-session'
  | 'session-list'
  | 'cycle-agent'
  | 'cycle-agent-reverse'
  | 'cycle-variant'
  | 'model-list'
  | 'theme-list'
  | 'submit-prompt'
  | 'newline'
  | 'clear-input'
  | 'scroll-page-up'
  | 'scroll-page-down'
  | 'scroll-half-page-up'
  | 'scroll-half-page-down'
  | 'scroll-to-first'
  | 'scroll-to-last'
  | 'child-session-next'
  | 'child-session-previous'
  | 'parent-session'
  | 'quit';

export type DesktopActionTarget =
  | { kind: 'command'; id: CommandPaletteActionId }
  | { kind: 'entrypoint'; id: CommandEntrypointId }
  | { kind: 'native'; id: DesktopNativeActionId }
  | { kind: 'unsupported'; action: string };

const TABLE: Record<string, Exclude<DesktopActionTarget, { kind: 'unsupported' }>> = {
  // Session lifecycle
  session_new: { kind: 'native', id: 'new-session' },
  session_list: { kind: 'native', id: 'session-list' },
  session_interrupt: { kind: 'native', id: 'interrupt' },
  session_share: { kind: 'command', id: 'share' },
  session_rename: { kind: 'command', id: 'rename' },
  session_fork: { kind: 'command', id: 'fork' },
  session_compact: { kind: 'command', id: 'compact' },
  session_export: { kind: 'command', id: 'export' },
  session_copy: { kind: 'command', id: 'copy' },
  session_timeline: { kind: 'command', id: 'timeline' },
  session_child_cycle: { kind: 'native', id: 'child-session-next' },
  session_child_cycle_reverse: { kind: 'native', id: 'child-session-previous' },
  session_parent: { kind: 'native', id: 'parent-session' },
  app_exit: { kind: 'native', id: 'quit' },

  // Selection surfaces
  command_list: { kind: 'entrypoint', id: 'commands' },
  diff_open: { kind: 'entrypoint', id: 'diffs' },
  status_view: { kind: 'entrypoint', id: 'session-details' },
  agent_list: { kind: 'entrypoint', id: 'settings' },
  model_list: { kind: 'native', id: 'model-list' },
  theme_list: { kind: 'native', id: 'theme-list' },
  agent_cycle: { kind: 'native', id: 'cycle-agent' },
  agent_cycle_reverse: { kind: 'native', id: 'cycle-agent-reverse' },
  variant_cycle: { kind: 'native', id: 'cycle-variant' },

  // Transcript
  messages_undo: { kind: 'command', id: 'undo' },
  messages_redo: { kind: 'command', id: 'redo' },
  messages_copy: { kind: 'command', id: 'copy' },
  messages_page_up: { kind: 'native', id: 'scroll-page-up' },
  messages_page_down: { kind: 'native', id: 'scroll-page-down' },
  messages_half_page_up: { kind: 'native', id: 'scroll-half-page-up' },
  messages_half_page_down: { kind: 'native', id: 'scroll-half-page-down' },
  messages_first: { kind: 'native', id: 'scroll-to-first' },
  messages_last: { kind: 'native', id: 'scroll-to-last' },

  // Display toggles
  display_thinking: { kind: 'command', id: 'toggle-thinking' },
  tool_details: { kind: 'command', id: 'toggle-actions' },
  session_toggle_timestamps: { kind: 'command', id: 'toggle-timestamps' },
  sidebar_toggle: { kind: 'command', id: 'toggle-sidebar' },

  // Prompt
  input_submit: { kind: 'native', id: 'submit-prompt' },
  prompt_submit: { kind: 'native', id: 'submit-prompt' },
  input_newline: { kind: 'native', id: 'newline' },
  input_clear: { kind: 'native', id: 'clear-input' },
  history_previous: { kind: 'command', id: 'prompt-history-previous' },
  history_next: { kind: 'command', id: 'prompt-history-next' },
  prompt_stash: { kind: 'command', id: 'prompt-stash' },
  prompt_stash_pop: { kind: 'command', id: 'prompt-stash-pop' },
  prompt_stash_list: { kind: 'command', id: 'prompt-stash-list' },

  // Subagents
  session_background: { kind: 'entrypoint', id: 'subagents' },
};

export function resolveDesktopAction(action: string): DesktopActionTarget {
  return TABLE[action] ?? { kind: 'unsupported', action };
}

export function mappedDesktopActions(): string[] {
  return Object.keys(TABLE).sort();
}

/**
 * Every command-palette id and entrypoint the table points at must exist. A typo
 * here would compile and then silently do nothing when the key is pressed, which
 * is the failure mode this whole module exists to prevent.
 */
export function danglingDesktopActionTargets(): string[] {
  const commandIds = new Set(getCommandPaletteActions().map((action) => action.id));
  const entrypointIds = new Set(commandPaletteEntrypoints.map((entrypoint) => entrypoint.id));

  const dangling: string[] = [];
  for (const [action, target] of Object.entries(TABLE)) {
    if (target.kind === 'command' && !commandIds.has(target.id)) dangling.push(`${action} -> command:${target.id}`);
    if (target.kind === 'entrypoint' && !entrypointIds.has(target.id)) dangling.push(`${action} -> entrypoint:${target.id}`);
  }
  return dangling.sort();
}
