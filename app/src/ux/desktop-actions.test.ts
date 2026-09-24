import { describe, expect, it } from 'vitest';

import {
  danglingDesktopActionTargets,
  mappedDesktopActions,
  resolveDesktopAction,
} from './desktop-actions';
import { commandPaletteEntrypoints, getCommandPaletteActions } from './tui-actions';

describe('desktop action mapping', () => {
  it('never points at a command or entrypoint that does not exist', () => {
    // A typo here compiles and then does nothing when the key is pressed, which
    // reads as a broken keybinding rather than a broken table.
    expect(danglingDesktopActionTargets()).toEqual([]);
  });

  it('routes session lifecycle keys to the actions the app already has', () => {
    expect(resolveDesktopAction('session_share')).toEqual({ kind: 'command', id: 'share' });
    expect(resolveDesktopAction('session_compact')).toEqual({ kind: 'command', id: 'compact' });
    expect(resolveDesktopAction('messages_undo')).toEqual({ kind: 'command', id: 'undo' });
    expect(resolveDesktopAction('session_interrupt')).toEqual({ kind: 'native', id: 'interrupt' });
    expect(resolveDesktopAction('command_list')).toEqual({ kind: 'entrypoint', id: 'commands' });
  });

  it('reports an unmapped action instead of swallowing the key', () => {
    const resolved = resolveDesktopAction('which_key_toggle');

    expect(resolved).toEqual({ kind: 'unsupported', action: 'which_key_toggle' });
  });

  it('covers every action the first desktop release promises', () => {
    // The P0 set from the keybinding survey. If one of these is dropped the
    // desktop client silently loses a documented capability.
    const required = [
      'input_submit',
      'input_newline',
      'session_interrupt',
      'session_new',
      'session_list',
      'command_list',
      'agent_cycle',
      'agent_cycle_reverse',
      'model_list',
      'variant_cycle',
      'messages_page_up',
      'messages_page_down',
      'messages_half_page_up',
      'messages_half_page_down',
      'messages_first',
      'messages_last',
      'theme_list',
      'sidebar_toggle',
      'app_exit',
      'messages_copy',
      'session_compact',
    ];

    const mapped = new Set(mappedDesktopActions());
    expect(required.filter((action) => !mapped.has(action))).toEqual([]);
  });

  it('binds the two capabilities the table leaves unbound but the desktop needs', () => {
    // diff_open and session_fork default to "none" in opencode's own table. The
    // desktop client is where they get a key, so the mapping has to know them.
    expect(resolveDesktopAction('diff_open')).toEqual({ kind: 'entrypoint', id: 'diffs' });
    expect(resolveDesktopAction('session_fork')).toEqual({ kind: 'command', id: 'fork' });
  });

  it('keeps every palette action reachable by some key', () => {
    const reachable = new Set(
      mappedDesktopActions()
        .map((action) => resolveDesktopAction(action))
        .filter((target) => target.kind === 'command')
        .map((target) => (target as { id: string }).id),
    );
    const unreachable = getCommandPaletteActions()
      .map((action) => action.id)
      .filter((id) => !reachable.has(id));

    expect(unreachable).toEqual([]);
  });

  it('keeps every entrypoint reachable by some key', () => {
    const reachable = new Set(
      mappedDesktopActions()
        .map((action) => resolveDesktopAction(action))
        .filter((target) => target.kind === 'entrypoint')
        .map((target) => (target as { id: string }).id),
    );
    const unreachable = commandPaletteEntrypoints
      .map((entrypoint) => entrypoint.id)
      .filter((id) => !reachable.has(id));

    expect(unreachable).toEqual([]);
  });
});
