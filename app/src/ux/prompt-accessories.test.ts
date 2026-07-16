import { describe, expect, it } from 'vitest';

import { appendClipboardText, createPromptAccessoryModel, enterFileReferenceMode } from './prompt-accessories';

describe('prompt accessories', () => {
  it('exposes paste and attach affordances for the TUI prompt dock', () => {
    const model = createPromptAccessoryModel({ prompt: 'hello', clipboardText: 'world', canAttachFiles: false });

    expect(model.actions).toEqual([
      {
        id: 'paste',
        label: 'Paste',
        detail: 'Insert clipboard text',
        disabled: false,
      },
      {
        id: 'attach',
        label: 'Attach',
        detail: 'File picker unavailable on this surface',
        disabled: true,
      },
    ]);
  });

  it('keeps paste available for manual fallback when the clipboard has no text', () => {
    const model = createPromptAccessoryModel({ prompt: '', clipboardText: '   ', canAttachFiles: true });

    expect(model.actions.find((action) => action.id === 'paste')).toMatchObject({
      disabled: false,
      detail: 'Paste manually',
    });
    expect(model.actions.find((action) => action.id === 'attach')).toMatchObject({
      disabled: false,
      detail: 'Attach a file reference',
    });
  });

  it('keeps paste enabled when clipboard text is unknown until a user gesture can read it', () => {
    const model = createPromptAccessoryModel({ prompt: '', clipboardText: null, canAttachFiles: false });

    expect(model.actions.find((action) => action.id === 'paste')).toMatchObject({
      disabled: false,
      detail: 'Read clipboard',
    });
  });


  it('appends clipboard text with prompt-friendly spacing', () => {
    expect(appendClipboardText('', ' pasted text ')).toBe('pasted text');
    expect(appendClipboardText('existing', 'pasted')).toBe('existing\npasted');
    expect(appendClipboardText('existing\n', 'pasted')).toBe('existing\npasted');
  });

  it('enters @ file-reference mode without damaging the current prompt', () => {
    expect(enterFileReferenceMode('')).toBe('@');
    expect(enterFileReferenceMode('read')).toBe('read @');
    expect(enterFileReferenceMode('read ')).toBe('read @');
    expect(enterFileReferenceMode('read @')).toBe('read @');
  });
});
