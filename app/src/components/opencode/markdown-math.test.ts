import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';

import { mathPlugin } from './markdown-math';

type Token = { type: string; content: string; children: Token[] | null; markup: string };

function parse(source: string) {
  const md = new MarkdownIt({ typographer: true });
  mathPlugin(md);
  return md.parse(source, {}) as Token[];
}

function inlineMath(source: string) {
  return parse(source)
    .flatMap((token) => token.children ?? [])
    .filter((token) => token.type === 'math_inline' || token.type === 'math_display')
    .map((token) => `${token.type}:${token.content}`);
}

function blockMath(source: string) {
  return parse(source)
    .filter((token) => token.type === 'math_block')
    .map((token) => token.content);
}

describe('mathPlugin', () => {
  it('reads $...$ and \\(...\\) as inline math', () => {
    expect(inlineMath('Energy $E = mc^2$ and \\(\\alpha_1\\) here')).toEqual([
      'math_inline:E = mc^2',
      'math_inline:\\alpha_1',
    ]);
  });

  it('leaves prices and lone dollar signs alone', () => {
    expect(inlineMath('It costs $5 and $10 today')).toEqual([]);
    expect(inlineMath('Pay $5.')).toEqual([]);
    expect(inlineMath('$ x $ has spaces inside the delimiters')).toEqual([]);
    expect(inlineMath('escaped \\$x\\$ stays text')).toEqual([]);
  });

  it('reads $$...$$ inside a sentence as display math', () => {
    expect(inlineMath('so $$\\int_0^1 f$$ holds')).toEqual(['math_display:\\int_0^1 f']);
  });

  it('reads $$ and \\[ blocks across lines', () => {
    expect(blockMath('Before\n\n$$\na^2 + b^2\n= c^2\n$$\n\nAfter')).toEqual(['a^2 + b^2\n= c^2']);
    expect(blockMath('\\[\n\\frac{1}{2}\n\\]')).toEqual(['\\frac{1}{2}']);
    expect(blockMath('$$ x = 1 $$')).toEqual(['x = 1']);
  });

  it('does not touch math inside code', () => {
    expect(inlineMath('`$x$` is code')).toEqual([]);
    expect(blockMath('```\n$$\nx\n$$\n```')).toEqual([]);
  });

  it('keeps an unterminated block as text', () => {
    expect(blockMath('$$\nnever closed')).toEqual([]);
  });

  it('keeps underscores and asterisks inside math away from emphasis', () => {
    const tokens = parse('$a_1 * b_2 * c$');
    const types = (tokens[1].children ?? []).map((token) => token.type);
    expect(types).toEqual(['math_inline']);
  });
});
