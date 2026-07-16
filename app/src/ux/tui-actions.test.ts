import { describe, expect, it } from 'vitest';

import {
  commandPaletteEntrypoints,
  getCommandPaletteActions,
  getMessageActions,
  getPromptControls,
  getThinkingLevelOptions,
  getSubagentCardAction,
} from './tui-actions';

describe('TUI-aligned mobile UX actions', () => {
  it('routes side panel and command palette through the overflow menu', () => {
    expect(commandPaletteEntrypoints.map((entry) => entry.id)).toEqual([
      'commands',
      'session-details',
      'subagents',
      'diffs',
      'settings',
    ]);
  });

  it('keeps the command palette aligned with TUI session commands', () => {
    const actions = getCommandPaletteActions();

    expect(actions.map((action) => action.id)).toEqual([
      'share',
      'rename',
      'timeline',
      'fork',
      'compact',
      'undo',
      'redo',
      'copy',
      'export',
      'toggle-thinking',
      'toggle-actions',
      'toggle-timestamps',
      'toggle-sidebar',
      'prompt-history-previous',
      'prompt-history-next',
      'prompt-stash',
      'prompt-stash-pop',
      'prompt-stash-list',
    ]);
    expect(actions.find((action) => action.id === 'share')?.disabled).toBeUndefined();
    expect(actions.find((action) => action.id === 'rename')?.disabled).toBeUndefined();
    expect(actions.find((action) => action.id === 'timeline')?.disabled).toBeUndefined();
    expect(actions.find((action) => action.id === 'fork')?.disabled).toBeUndefined();
    expect(actions.find((action) => action.id === 'compact')?.disabled).toBe(false);
    expect(actions.find((action) => action.id === 'undo')).toMatchObject({
      disabled: true,
      detail: 'No user message available to revert',
    });
    expect(actions.find((action) => action.id === 'redo')).toMatchObject({
      disabled: true,
      detail: 'No reverted message to redo',
    });
    expect(actions.find((action) => action.id === 'copy')?.disabled).toBeUndefined();
    expect(actions.find((action) => action.id === 'toggle-actions')?.disabled).toBeUndefined();
    expect(actions.find((action) => action.id === 'toggle-timestamps')?.disabled).toBeUndefined();
  });

  it('keeps Compact visible but disabled when no selected agent model can run summarization', () => {
    expect(getCommandPaletteActions({ canCompact: false }).find((action) => action.id === 'compact')).toMatchObject({
      disabled: true,
      detail: 'Compact requires a selected agent model',
    });
  });

  it('keeps session-scoped commands visible but disabled from the prompt-first workbench', () => {
    const actions = getCommandPaletteActions({ scope: 'workbench', canUndo: true, canRedo: true });
    const disabledIds = [
      'share',
      'rename',
      'timeline',
      'fork',
      'compact',
      'undo',
      'redo',
      'copy',
      'export',
      'toggle-actions',
      'toggle-timestamps',
      'toggle-sidebar',
    ];

    for (const id of disabledIds) {
      expect(actions.find((action) => action.id === id)).toMatchObject({
        disabled: true,
        detail: 'Select a session to use this command',
      });
    }
    expect(actions.find((action) => action.id === 'toggle-thinking')?.disabled).toBeUndefined();
    expect(actions.find((action) => action.id === 'prompt-history-previous')?.disabled).toBeUndefined();
    expect(actions.find((action) => action.id === 'prompt-stash')?.disabled).toBeUndefined();
  });

  it('enables Undo when the session transcript has a user message to revert', () => {
    expect(getCommandPaletteActions({ canUndo: true }).find((action) => action.id === 'undo')).toMatchObject({
      disabled: false,
      detail: 'Revert to the latest user message',
    });
  });

  it('enables Redo only when the session has a revert cursor', () => {
    expect(getCommandPaletteActions({ canRedo: true }).find((action) => action.id === 'redo')).toMatchObject({
      disabled: false,
      detail: 'Move to the next reverted user message or restore all',
    });
  });

  it('opens subagent cards as child session transcripts', () => {
    expect(getSubagentCardAction({ sessionId: 'child-1', status: 'running' })).toEqual({
      type: 'navigate',
      route: '/session/child-1',
      label: 'Open transcript',
    });
  });

  it('exposes fork, revert, timeline jump, and copy on user messages', () => {
    const actions = getMessageActions({ role: 'user', messageId: 'm1', canFork: true, canRevert: true, canTimeline: true });

    expect(actions.map((action) => action.id)).toEqual(['fork', 'revert', 'timeline', 'copy']);
    expect(actions.find((action) => action.id === 'fork')).toMatchObject({ disabled: false });
    expect(actions.find((action) => action.id === 'revert')).toMatchObject({ disabled: false });
    expect(actions.find((action) => action.id === 'timeline')).toMatchObject({ disabled: false });
    expect(actions.find((action) => action.id === 'copy')).toMatchObject({ disabled: false });
  });

  it('keeps user-message fork and revert visible but disabled when callbacks are unavailable', () => {
    const actions = getMessageActions({ role: 'user', messageId: 'm1' });

    expect(actions.find((action) => action.id === 'fork')).toMatchObject({
      disabled: true,
      detail: 'Fork API is not available in this mobile build yet',
    });
    expect(actions.find((action) => action.id === 'revert')).toMatchObject({
      disabled: true,
      detail: 'Revert API is not available in this mobile build yet',
    });
    expect(actions.find((action) => action.id === 'timeline')).toMatchObject({
      disabled: true,
      detail: 'Timeline UI is not wired yet',
    });
  });

  it('marks all transcript surfaces as copyable', () => {
    expect(getMessageActions({ role: 'assistant', messageId: 'm2' }).map((action) => action.id)).toContain('copy');
    expect(getMessageActions({ role: 'tool', messageId: 'm3' }).map((action) => action.id)).toContain('copy-raw');
  });

  it('maps Tab, ctrl+t, and esc TUI controls to touch controls', () => {
    expect(getPromptControls()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tuiKey: 'tab', mobileControl: 'agent-chip' }),
        expect.objectContaining({ tuiKey: 'ctrl+t', mobileControl: 'thinking-chip' }),
        expect.objectContaining({ tuiKey: 'esc', mobileControl: 'interrupt-button' }),
      ]),
    );
  });

  it('exposes explicit thinking-level choices in the mobile thinking chip menu', () => {
    expect(getThinkingLevelOptions().map((option) => option.id)).toEqual(['low', 'medium', 'high', 'max']);
    expect(getThinkingLevelOptions()).toContainEqual(
      expect.objectContaining({
        id: 'high',
        label: 'High',
        detail: 'TUI ctrl+t thinking level',
      }),
    );
  });
});
