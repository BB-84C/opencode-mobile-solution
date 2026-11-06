import { describe, expect, it } from 'vitest';

import { markdownToSpans, spansToText } from './markdown-spans';

describe('markdownToSpans', () => {
  it('keeps a whole message as one string so a selection can cross blocks', () => {
    const spans = markdownToSpans('# Title\n\nFirst paragraph.\n\nSecond one.');
    expect(spansToText(spans)).toBe('Title\n\nFirst paragraph.\n\nSecond one.');
    expect(spans[0]).toMatchObject({ text: 'Title', kinds: ['heading1'] });
  });

  it('marks inline styles and links', () => {
    const spans = markdownToSpans('a **b** *c* ~~d~~ `e` [f](https://x.dev)');
    expect(spansToText(spans)).toBe('a b c d e f');
    expect(spans.find((s) => s.text === 'b')?.kinds).toEqual(['strong']);
    expect(spans.find((s) => s.text === 'c')?.kinds).toEqual(['em']);
    expect(spans.find((s) => s.text === 'd')?.kinds).toEqual(['s']);
    expect(spans.find((s) => s.text === 'e')?.kinds).toEqual(['code']);
    expect(spans.find((s) => s.text === 'f')).toMatchObject({ kinds: ['link'], href: 'https://x.dev' });
  });

  it('turns soft and hard breaks into newlines', () => {
    expect(spansToText(markdownToSpans('one\ntwo  \nthree'))).toBe('one\ntwo\nthree');
  });

  it('writes list markers, nesting and ordered numbers', () => {
    const text = spansToText(markdownToSpans('- a\n- b\n  1. c\n  2. d\n\n3. x\n4. y'));
    expect(text).toBe('• a\n• b\n    1. c\n    2. d\n\n3. x\n4. y');
  });

  it('keeps code blocks verbatim, without the trailing newline', () => {
    const spans = markdownToSpans('before\n\n```js\nconst x = 1;\n  indented\n```\n\nafter');
    expect(spansToText(spans)).toBe('before\n\nconst x = 1;\n  indented\n\nafter');
    expect(spans.find((s) => s.text.includes('const'))?.kinds).toEqual(['codeBlock']);
  });

  it('prefixes quoted lines and renders tables, rules and images as text', () => {
    const text = spansToText(markdownToSpans('> q1\n> q2\n\n| h1 | h2 |\n|---|---|\n| a | b |\n\n---\n\n![alt](u)'));
    expect(text).toBe('│ q1\n│ q2\n\nh1 │ h2\na │ b\n\n────────\n\n[image: alt]');
  });

  it('returns nothing for blank input', () => {
    expect(markdownToSpans('   \n')).toEqual([]);
  });
});
