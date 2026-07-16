export type CommandEntrypointId = 'commands' | 'session-details' | 'subagents' | 'diffs' | 'settings';

export const commandPaletteEntrypoints: Array<{ id: CommandEntrypointId; label: string }> = [
  { id: 'commands', label: 'Commands' },
  { id: 'session-details', label: 'Session details' },
  { id: 'subagents', label: 'Subagents' },
  { id: 'diffs', label: 'Diffs' },
  { id: 'settings', label: 'Settings' },
];

export type CommandPaletteActionId =
  | 'share'
  | 'rename'
  | 'timeline'
  | 'fork'
  | 'compact'
  | 'undo'
  | 'redo'
  | 'copy'
  | 'export'
  | 'toggle-thinking'
  | 'toggle-actions'
  | 'toggle-timestamps'
  | 'toggle-sidebar'
  | 'prompt-history-previous'
  | 'prompt-history-next'
  | 'prompt-stash'
  | 'prompt-stash-pop'
  | 'prompt-stash-list';

export interface CommandPaletteAction {
  id: CommandPaletteActionId;
  label: string;
  detail?: string;
  disabled?: boolean;
}

export type ThinkingLevel = 'low' | 'medium' | 'high' | 'max';

export interface ThinkingLevelOption {
  id: ThinkingLevel;
  label: string;
  detail: string;
}

export function getCommandPaletteActions(
  input: { canCompact?: boolean; canUndo?: boolean; canRedo?: boolean; scope?: 'session' | 'workbench' } = {},
): CommandPaletteAction[] {
  const workbenchScope = input.scope === 'workbench';
  const compactAvailable = input.canCompact ?? true;
  const undoAvailable = input.canUndo ?? false;
  const redoAvailable = input.canRedo ?? false;
  const actions: CommandPaletteAction[] = [
    { id: 'share', label: 'Share session' },
    { id: 'rename', label: 'Rename session' },
    { id: 'timeline', label: 'Timeline / jump to message' },
    { id: 'fork', label: 'Fork session' },
    {
      id: 'compact',
      label: 'Compact session',
      disabled: !compactAvailable,
      detail: compactAvailable ? undefined : 'Compact requires a selected agent model',
    },
    {
      id: 'undo',
      label: 'Undo',
      disabled: !undoAvailable,
      detail: undoAvailable ? 'Revert to the latest user message' : 'No user message available to revert',
    },
    {
      id: 'redo',
      label: 'Redo',
      disabled: !redoAvailable,
      detail: redoAvailable ? 'Move to the next reverted user message or restore all' : 'No reverted message to redo',
    },
    { id: 'copy', label: 'Copy session transcript' },
    { id: 'export', label: 'Export transcript' },
    { id: 'toggle-thinking', label: 'Toggle thinking', detail: 'ctrl+t' },
    { id: 'toggle-actions', label: 'Toggle actions' },
    { id: 'toggle-timestamps', label: 'Toggle timestamps' },
    { id: 'toggle-sidebar', label: 'Toggle sidebar' },
    { id: 'prompt-history-previous', label: 'Previous prompt', detail: 'history_previous' },
    { id: 'prompt-history-next', label: 'Next prompt', detail: 'history_next' },
    { id: 'prompt-stash', label: 'Stash prompt' },
    { id: 'prompt-stash-pop', label: 'Pop stashed prompt' },
    { id: 'prompt-stash-list', label: 'List stashed prompts' },
  ];
  if (!workbenchScope) return actions;

  const sessionScoped = new Set<CommandPaletteActionId>([
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
  ]);
  return actions.map((action) =>
    sessionScoped.has(action.id)
      ? {
          ...action,
          disabled: true,
          detail: 'Select a session to use this command',
        }
      : action,
  );
}

export type TranscriptRole = 'user' | 'assistant' | 'tool' | 'reasoning' | 'error';

export function getSubagentCardAction(input: { sessionId?: string; status: 'running' | 'completed' | 'retry' }) {
  if (!input.sessionId) {
    return { type: 'disabled' as const, label: 'Transcript unavailable' };
  }
  return {
    type: 'navigate' as const,
    route: `/session/${input.sessionId}`,
    label: 'Open transcript',
  };
}

export function getMessageActions(input: {
  role: TranscriptRole;
  messageId: string;
  canFork?: boolean;
  canRevert?: boolean;
  canTimeline?: boolean;
}) {
  if (input.role === 'user') {
    return [
      {
        id: 'fork',
        label: 'Fork from here',
        disabled: !input.canFork,
        detail: input.canFork ? undefined : 'Fork API is not available in this mobile build yet',
      },
      {
        id: 'revert',
        label: 'Revert to here',
        disabled: !input.canRevert,
        detail: input.canRevert ? undefined : 'Revert API is not available in this mobile build yet',
      },
      {
        id: 'timeline',
        label: 'Jump / Timeline',
        disabled: !input.canTimeline,
        detail: input.canTimeline ? undefined : 'Timeline UI is not wired yet',
      },
      { id: 'copy', label: 'Copy', disabled: false },
    ];
  }

  if (input.role === 'tool') {
    return [
      { id: 'copy', label: 'Copy visible text' },
      { id: 'copy-raw', label: 'Copy raw output' },
      { id: 'open-text-view', label: 'Open text view' },
    ];
  }

  return [
    { id: 'copy', label: 'Copy' },
    { id: 'open-text-view', label: 'Open text view' },
  ];
}

export function getPromptControls() {
  return [
    {
      tuiKey: 'tab',
      mobileControl: 'agent-chip',
      label: 'Cycle agent',
    },
    {
      tuiKey: 'ctrl+t',
      mobileControl: 'thinking-chip',
      label: 'Cycle thinking level',
    },
    {
      tuiKey: 'esc',
      mobileControl: 'interrupt-button',
      label: 'Interrupt',
    },
  ];
}

export function getThinkingLevelOptions(): ThinkingLevelOption[] {
  return [
    { id: 'low', label: 'Low', detail: 'TUI ctrl+t thinking level' },
    { id: 'medium', label: 'Medium', detail: 'TUI ctrl+t thinking level' },
    { id: 'high', label: 'High', detail: 'TUI ctrl+t thinking level' },
    { id: 'max', label: 'Max', detail: 'TUI ctrl+t thinking level' },
  ];
}
