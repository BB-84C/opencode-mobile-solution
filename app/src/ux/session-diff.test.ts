import { describe, expect, it } from 'vitest';

import { createDiffCopyModel, createDiffPresentationModel, diffToUnifiedText } from './session-diff';
import type { FileDiff } from '@/src/opencode/types';

const diffs: FileDiff[] = [
  {
    path: 'src/app.ts',
    hunks: [
      {
        oldStart: 10,
        oldLines: 2,
        newStart: 10,
        newLines: 3,
        lines: [
          { type: 'context', content: 'const keep = true;', oldLineNumber: 10, newLineNumber: 10 },
          { type: 'remove', content: 'const oldName = 1;', oldLineNumber: 11 },
          { type: 'add', content: 'const newName = 1;', newLineNumber: 11 },
          { type: 'add', content: 'const added = 2;', newLineNumber: 12 },
        ],
      },
    ],
  },
];

describe('session diff copy model', () => {
  it('formats file diffs as unified diff text', () => {
    expect(diffToUnifiedText(diffs)).toBe(
      [
        'diff -- src/app.ts',
        '--- src/app.ts',
        '+++ src/app.ts',
        '@@ -10,2 +10,3 @@',
        ' const keep = true;',
        '-const oldName = 1;',
        '+const newName = 1;',
        '+const added = 2;',
      ].join('\n'),
    );
  });

  it('handles empty diffs without inventing content', () => {
    expect(diffToUnifiedText([])).toBe('');
    expect(createDiffCopyModel([])).toEqual({
      changedFiles: 0,
      title: 'Diffs',
      text: '',
      presentation: {
        defaultMode: 'unified',
        mode: 'unified',
        splitAllowed: false,
        wordWrap: true,
        unifiedTextDefault: true,
      },
      actions: [
        { id: 'copy', label: 'Copy', disabled: true },
        { id: 'copy-raw', label: 'Copy raw', disabled: true },
        { id: 'open-text-view', label: 'Open text view', disabled: true },
      ],
    });
  });

  it('exposes copy and text-view actions when diff text exists', () => {
    expect(createDiffCopyModel(diffs)).toMatchObject({
      changedFiles: 1,
      title: 'Diffs',
      text: expect.stringContaining('+const newName = 1;'),
      presentation: {
        defaultMode: 'unified',
        mode: 'unified',
        splitAllowed: false,
        wordWrap: true,
        unifiedTextDefault: true,
      },
      actions: [
        { id: 'copy', label: 'Copy', disabled: false },
        { id: 'copy-raw', label: 'Copy raw', disabled: false },
        { id: 'open-text-view', label: 'Open text view', disabled: false },
      ],
    });
  });

  it('defaults phone portrait diffs to unified word-wrapped text', () => {
    expect(createDiffPresentationModel({ width: 390, height: 844, isTablet: false })).toEqual({
      defaultMode: 'unified',
      mode: 'unified',
      splitAllowed: false,
      wordWrap: true,
      unifiedTextDefault: true,
    });
    expect(createDiffPresentationModel({ width: 390, height: 844, isTablet: false }, 'split')).toEqual({
      defaultMode: 'unified',
      mode: 'unified',
      splitAllowed: false,
      wordWrap: true,
      unifiedTextDefault: true,
    });
  });

  it('allows split diff only when tablet or landscape explicitly requests it', () => {
    expect(createDiffPresentationModel({ width: 844, height: 390, isTablet: false })).toEqual({
      defaultMode: 'unified',
      mode: 'unified',
      splitAllowed: true,
      wordWrap: true,
      unifiedTextDefault: true,
    });
    expect(createDiffPresentationModel({ width: 844, height: 390, isTablet: false }, 'split')).toEqual({
      defaultMode: 'unified',
      mode: 'split',
      splitAllowed: true,
      wordWrap: false,
      unifiedTextDefault: true,
    });
    expect(createDiffPresentationModel({ width: 744, height: 1133, isTablet: true }, 'split')).toEqual({
      defaultMode: 'unified',
      mode: 'split',
      splitAllowed: true,
      wordWrap: false,
      unifiedTextDefault: true,
    });
  });
});
