import { describe, expect, it } from 'vitest';

import { createTodoBoardModel } from './todo-board';

describe('createTodoBoardModel', () => {
  const todos = [
    { content: 'Read the code', status: 'completed', priority: 'high' },
    { content: 'Write the test', status: 'in_progress', priority: 'high' },
    { content: 'Fix it', status: 'pending', priority: 'medium' },
    { content: 'Old idea', status: 'cancelled', priority: 'low' },
  ];

  it('counts progress and names the task in progress', () => {
    const board = createTodoBoardModel(todos);
    expect(board).toMatchObject({ total: 4, finished: 2, open: 2, allDone: false, summary: 'Now: Write the test' });
    expect(board.rows.map((row) => `${row.marker} ${row.content}`)).toEqual([
      '[✓] Read the code',
      '[•] Write the test',
      '[ ] Fix it',
      '[✗] Old idea',
    ]);
  });

  it('points at the next pending task when nothing is in progress, and reports completion', () => {
    expect(createTodoBoardModel(todos.map((todo) => (todo.status === 'in_progress' ? { ...todo, status: 'pending' } : todo))).summary)
      .toBe('Next: Write the test');
    expect(createTodoBoardModel([{ content: 'a', status: 'completed', priority: 'low' }])).toMatchObject({ allDone: true, summary: 'All done' });
    expect(createTodoBoardModel(undefined)).toMatchObject({ total: 0, summary: 'No todos', allDone: false });
  });
});
