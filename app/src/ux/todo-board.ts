import type { TodoItem } from '@/src/opencode/types';

/**
 * The session's todo list as the TUI sidebar shows it: what the main agent
 * planned, how far it got, and what it is doing now.
 */
export type TodoState = 'completed' | 'in_progress' | 'pending' | 'cancelled';

export interface TodoBoardRow {
  key: string;
  marker: string;
  state: TodoState;
  content: string;
  priority: string;
}

const MARKERS: Record<TodoState, string> = {
  completed: '[✓]',
  in_progress: '[•]',
  pending: '[ ]',
  cancelled: '[✗]',
};

function stateOf(status: string): TodoState {
  return status === 'completed' || status === 'in_progress' || status === 'cancelled' ? status : 'pending';
}

export function createTodoBoardModel(todos: readonly TodoItem[] | undefined) {
  const rows: TodoBoardRow[] = (todos ?? []).map((todo, index) => {
    const state = stateOf(todo.status);
    return { key: `${index}:${todo.content}`, marker: MARKERS[state], state, content: todo.content, priority: todo.priority };
  });
  const finished = rows.filter((row) => row.state === 'completed' || row.state === 'cancelled').length;
  const current = rows.find((row) => row.state === 'in_progress') ?? null;
  const next = current ? null : rows.find((row) => row.state === 'pending') ?? null;
  return {
    rows,
    total: rows.length,
    finished,
    open: rows.length - finished,
    current,
    allDone: rows.length > 0 && finished === rows.length,
    summary: rows.length === 0
      ? 'No todos'
      : current
        ? `Now: ${current.content}`
        : next
          ? `Next: ${next.content}`
          : 'All done',
  };
}
